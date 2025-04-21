import {
  createRenderer, // 用于创建 Vue SSR 渲染器（核心函数）
} from 'vue-bundle-renderer/runtime'
// 类型导入：定义客户端构建资源清单的结构
import type { Manifest as ClientManifest } from 'vue-bundle-renderer'
// 类型导入：Vite 的资源清单结构
import type { Manifest } from 'vite'
// ssr 的核心 renderToString
// Vue 提供的将组件渲染为 HTML 字符串的函数（SSR）
import { renderToString as _renderToString } from 'vue/server-renderer'
// 用于将组件的 props 转换成 HTML 字符串
import { propsToString } from '@unhead/vue/server'

// Nuxt 在 SSR 过程中传递的上下文类型
import type { NuxtSSRContext } from 'nuxt/app'
// 获取运行时配置，用于获取 public 和 app 的配置内容
import { useRuntimeConfig } from '#internal/nitro'

// @ts-expect-error virtual file // 虚拟文件，来自构建后的 Nuxt 配置
import { appRootAttrs, appRootTag, appSpaLoaderAttrs, appSpaLoaderTag, spaLoadingTemplateOutside } from '#internal/nuxt.config.mjs'
// @ts-expect-error virtual file // 获取构建资源的完整 URL（如 publicPath）
import { buildAssetsURL } from '#internal/nuxt/paths'

// 构建 HTML 的开标签，如 <div id="__nuxt">
const APP_ROOT_OPEN_TAG = `<${appRootTag}${propsToString(appRootAttrs)}>`
// 构建 HTML 的闭标签，如 </div>
const APP_ROOT_CLOSE_TAG = `</${appRootTag}>`

// @ts-expect-error file will be produced after app build
export const getClientManifest: () => Promise<Manifest> = () => import('#build/dist/server/client.manifest.mjs') // 动态导入客户端 manifest 文件
  .then(r => r.default || r)  // 有 default 导出就用 default
  .then(r => typeof r === 'function' ? r() : r) as Promise<ClientManifest> // 如果导入的是函数就执行，否则直接返回 manifest

// 从 manifest 中筛选出全局 CSS 的资源路径
export const getEntryIds: () => Promise<string[]> = () => getClientManifest().then(r => Object.values(r).filter(r =>
  // @ts-expect-error internal key set by CSS inlining configuration
  r._globalCSS,
).map(r => r.src!))

// @ts-expect-error file will be produced after app build
// 动态导入服务器端渲染入口函数（导出 createApp）
export const getServerEntry = () => import('#build/dist/server/server.mjs').then(r => r.default || r)

// @ts-expect-error file will be produced after app build
// 获取每个组件对应的内联样式信息，懒加载并缓存
export const getSSRStyles = lazyCachedFunction((): Promise<Record<string, () => Promise<string[]>>> => import('#build/dist/server/styles.mjs').then(r => r.default || r))

// -- SSR Renderer --
//  SSR 渲染器（服务端）
export const getSSRRenderer = lazyCachedFunction(async () => {
  // Load client manifest
  // manifest
  // 加载客户端 manifest 文件
  const manifest = await getClientManifest()
  if (!manifest) { throw new Error('client.manifest is not available') }

  // Load server bundle
  // 加载服务器端应用入口（createApp）
  const createSSRApp = await getServerEntry()
  if (!createSSRApp) { throw new Error('Server bundle is not available') }

  // 渲染器配置项
  const options = {
    manifest,
    renderToString,
    buildAssetsURL,
  }
  // Create renderer
  // 创建 SSR 渲染器实例
  const renderer = createRenderer(createSSRApp, options)

  // 获取 renderToString 的参数类型（Vue 组件、上下文）
  type RenderToStringParams = Parameters<typeof _renderToString>
  async function renderToString (input: RenderToStringParams[0], context: RenderToStringParams[1]) {
    // 将 Vue 应用渲染为字符串
    const html = await _renderToString(input, context)
    // In development with vite-node, the manifest is on-demand and will be available after rendering
    if (import.meta.dev && process.env.NUXT_VITE_NODE_OPTIONS) {
      // 开发模式下支持热更新，重新更新 manifest
      renderer.rendererContext.updateManifest(await getClientManifest())
    }
    // 用 Nuxt root 标签包裹渲染后的 HTML
    return APP_ROOT_OPEN_TAG + html + APP_ROOT_CLOSE_TAG
  }

  // 返回渲染器对象
  return renderer
})

// -- SPA Renderer --
// SPA 渲染器（客户端渲染，服务端只返回模板）
export const getSPARenderer = lazyCachedFunction(async () => {
  // manifest
  // 获取客户端 manifest
  const manifest = await getClientManifest()

  // 渲染 SPA 模板，如果设置了在外部加载 loading 模板，则拼接 loader
  // @ts-expect-error virtual file
  const spaTemplate = await import('#spa-template').then(r => r.template).catch(() => '')
    .then((r) => {
      if (spaLoadingTemplateOutside) {
        const APP_SPA_LOADER_OPEN_TAG = `<${appSpaLoaderTag}${propsToString(appSpaLoaderAttrs)}>`
        const APP_SPA_LOADER_CLOSE_TAG = `</${appSpaLoaderTag}>`
        const appTemplate = APP_ROOT_OPEN_TAG + APP_ROOT_CLOSE_TAG
        const loaderTemplate = r ? APP_SPA_LOADER_OPEN_TAG + r + APP_SPA_LOADER_CLOSE_TAG : ''
        return appTemplate + loaderTemplate
      } else {
        return APP_ROOT_OPEN_TAG + r + APP_ROOT_CLOSE_TAG
      }
    })

  // 使用静态模板的方式创建伪 SSR 渲染器
  const options = {
    manifest,
    renderToString: () => spaTemplate,
    buildAssetsURL,
  }
  // Create SPA renderer and cache the result for all requests
  // 生成 SPA 模板 HTML
  const renderer = createRenderer(() => () => {}, options)
  const result = await renderer.renderToString({})

  // 返回固定的 HTML，并设置一些 SSR 上下文属性
  const renderToString = (ssrContext: NuxtSSRContext) => {
    const config = useRuntimeConfig(ssrContext.event)
    ssrContext.modules ||= new Set<string>()
    ssrContext.payload.serverRendered = false
    ssrContext.config = {
      public: config.public,
      app: config.app,
    }
    return Promise.resolve(result)
  }

  return {
    rendererContext: renderer.rendererContext,
    renderToString,
  }
})

// 通用懒加载缓存函数
// 通用函数：只执行一次加载逻辑，后续返回缓存结果；如果出错会清空缓存
function lazyCachedFunction<T> (fn: () => Promise<T>): () => Promise<T> {
  let res: Promise<T> | null = null
  return () => {
    if (res === null) {
      res = fn().catch((err) => { res = null; throw err })
    }
    return res
  }
}
