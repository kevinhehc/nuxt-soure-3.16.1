// 从 Node.js 的 async_hooks 模块中引入 AsyncLocalStorage，用于异步上下文存储（类似线程本地存储）
import { AsyncLocalStorage } from 'node:async_hooks'
// 从 vue-bundle-renderer/runtime 中引入几个与资源链接渲染相关的工具函数
import {
  getPrefetchLinks, // 获取 prefetch 资源链接
  getPreloadLinks, // 获取 preload 资源链接
  getRequestDependencies, // 获取请求中使用到的依赖资源
  renderResourceHeaders,  // 渲染资源的 HTTP 头（如 Link）
} from 'vue-bundle-renderer/runtime'
// 引入类型定义：RenderResponse 用于表示 Nitro 的渲染响应结构
import type { RenderResponse } from 'nitropack'
// 表示 H3 框架中封装的 HTTP 请求事件对象
import type { H3Event } from 'h3'
// 引入 H3 框架中的一系列工具函数
import {
  appendResponseHeader,// 向响应中追加头信息
  createError, // 创建错误对象
  getQuery,// 获取请求查询参数
  getResponseStatus,// 获取响应状态码
  getResponseStatusText, // 获取响应状态文本
  readBody, // 读取请求体
  writeEarlyHints// 写入 HTTP/2 的 Early Hints 提前提示资源
} from 'h3'

// destr 是一个安全的 JSON 解析工具，比 JSON.parse 更容错
import destr from 'destr'
// 从 ufo 工具库中导入 URL 操作相关工具
import { getQuery as getURLQuery, joinURL, withoutTrailingSlash } from 'ufo'
// 引入 head 标签渲染相关工具（用于服务端渲染 <head> 标签）
import { createHead, propsToString, renderSSRHead } from '@unhead/vue/server'
import { resolveUnrefHeadInput } from '@unhead/vue/utils'
// 引入 <head> 标签内容类型定义
import type { HeadEntryOptions, Link, Script, SerializableHead, Style } from '@unhead/vue/types'

// Nuxt 应用的核心类型定义
import type { NuxtPayload, NuxtSSRContext } from 'nuxt/app'

// SSR 渲染相关的工具函数（getSSRRenderer 是 SSR 核心函数）
import {
  getEntryIds, // 获取当前路由使用到的入口文件 IDs
  getSPARenderer, // 获取 SPA 模式下的渲染器
  getSSRRenderer, // 获取 SSR 渲染器
  getSSRStyles  // 获取 SSR 渲染过程中生成的样式
} from '../utils/build-files'

// 服务端渲染中使用的缓存对象：island（组件岛）缓存、payload 缓存等
import {
  islandCache, // 组件岛缓存
  islandPropCache,  // 组件岛 props 缓存
  payloadCache,  // payload JSON 缓存
  sharedPrerenderCache // 用于预渲染共享缓存
} from '../utils/cache'

// payload 渲染相关工具函数
import {
  renderPayloadJsonScript, // 渲染 <script> 标签形式的 JSON payload
  renderPayloadResponse, // 渲染 API 响应形式的 payload
  renderPayloadScript, // 渲染 payload 的 <script> 标签
  splitPayload // 拆分 payload 数据
} from '../utils/payload'

// Nitro 提供的服务端渲染相关函数
import {
  defineRenderHandler, // 定义 SSR 渲染处理函数
  getRouteRules, // 获取路由规则（比如缓存、静态化配置）
  useNitroApp, // 获取当前的 Nitro 应用实例
  useRuntimeConfig  // 获取运行时配置（如 .env 中变量）
} from '#internal/nitro'


// 以下是虚拟模块（Nuxt 编译时注入的内部配置）
// @ts-expect-error virtual file 是为了忽略这些虚拟模块在类型系统中找不到的问题
import unheadOptions from '#internal/unhead-options.mjs'  // 用于配置 <head> 渲染
// @ts-expect-error virtual file
import { renderSSRHeadOptions } from '#internal/unhead.config.mjs' // <head> 渲染的 SSR 配置选项

// 引入 Nuxt 生成的应用运行配置（如是否启用组件岛架构）
//   appHead,              // 应用级默认 <head> 配置
//   appRootTag,           // 根组件包裹的 HTML 标签名
//   appTeleportAttrs,     // Teleport 组件的 HTML 属性
//   appTeleportTag,       // Teleport 插入到的标签名
//   componentIslands,     // 是否启用了组件岛架构
//   appManifest as isAppManifestEnabled // 是否启用了 manifest（PWA）

// @ts-expect-error virtual file
import { appHead, appRootTag, appTeleportAttrs, appTeleportTag, componentIslands, appManifest as isAppManifestEnabled } from '#internal/nuxt.config.mjs'


// // 静态资源路径构建函数
// import {
//   buildAssetsURL,       // 构建 build 后资源的完整 URL
//   publicAssetsURL       // 构建 public 目录下资源的完整 URL
// } from '#internal/nuxt/paths'

// @ts-expect-error virtual file
import { buildAssetsURL, publicAssetsURL } from '#internal/nuxt/paths'


// 以下为 vite 插件辅助函数设置全局变量（供生成的代码访问资源路径）
// @ts-expect-error 是因为这些属性在 globalThis 上不存在，属于 hack 写法
globalThis.__buildAssetsURL = buildAssetsURL
// @ts-expect-error private property consumed by vite-generated url helpers
globalThis.__publicAssetsURL = publicAssetsURL

// Polyfill for unctx (https://github.com/unjs/unctx#native-async-context)
// 为了支持 async context 的 polyfill，如果设置了 NUXT_ASYNC_CONTEXT 且当前环境不支持 AsyncLocalStorage，则手动挂载上
if (process.env.NUXT_ASYNC_CONTEXT && !('AsyncLocalStorage' in globalThis)) {
  // 强制将 AsyncLocalStorage 设置为全局变量
  (globalThis as any).AsyncLocalStorage = AsyncLocalStorage
}

// 表示整个 HTML 页面渲染时使用的上下文数据结构
export interface NuxtRenderHTMLContext {
  island?: boolean // 是否是 island（客户端组件渲染）模式
  htmlAttrs: string[] // <html> 标签的属性集合
  head: string[] // <head> 区域的 HTML 字符串数组
  bodyAttrs: string[] // <body> 标签的属性集合
  bodyPrepend: string[] // 插入到 <body> 开始前的 HTML
  body: string[] // 插入到 <body> 中的主要 HTML 内容
  bodyAppend: string[] // 插入到 <body> 结尾后的 HTML
}

// 表示 island（部分客户端组件）中 slot 的返回结构
export interface NuxtIslandSlotResponse {
  props: Array<unknown> // 插槽的 props（属性）数组
  fallback?: string // 回退 HTML（在客户端渲染失败时使用）
}


// 表示 island 客户端组件渲染后的响应结构
export interface NuxtIslandClientResponse {
  html: string // 渲染后的 HTML 字符串
  props: unknown // 组件的 props
  chunk: string // 该组件所属的 JavaScript chunk 名称
  slots?: Record<string, string> // 组件包含的插槽及其 HTML 内容
}


// 表示服务端渲染 island 组件时的上下文
export interface NuxtIslandContext {
  id?: string // 每个组件的唯一 ID（用于识别）
  name: string // 组件名
  props?: Record<string, any> // 传递给组件的属性
  url?: string // 请求的 URL
  slots: Record<string, Omit<NuxtIslandSlotResponse, 'html' | 'fallback'>> // 插槽内容（省略 HTML 和 fallback）
  components: Record<string, Omit<NuxtIslandClientResponse, 'html'>> // 子组件内容（省略 HTML）
}

// 表示 island 渲染后的返回结果
export interface NuxtIslandResponse {
  id?: string // island 的 ID
  html: string // 渲染后的 HTML
  head: SerializableHead // 头部内容（包括 meta、title 等）
  props?: Record<string, Record<string, any>> // 所有组件的 props
  components?: Record<string, NuxtIslandClientResponse> // 所有子组件的渲染结果
  slots?: Record<string, NuxtIslandSlotResponse> // 插槽渲染结果
}

// 页面最终渲染输出的结构
export interface NuxtRenderResponse {
  body: string // 页面 HTML 内容
  statusCode: number // HTTP 状态码
  statusMessage?: string // 状态码说明
  headers: Record<string, string> // HTTP 响应头
}

// 正则：匹配以 .json 结尾的 island 请求路径（可能带有查询参数）
const ISLAND_SUFFIX_RE = /\.json(\?.*)?$/
// 获取 Island 渲染上下文函数
async function getIslandContext (event: H3Event): Promise<NuxtIslandContext> {
  // TODO: Strict validation for url
  // TODO: 后续严格验证 URL 合法性
  let url = event.path || ''
  // 如果在 prerender 阶段，并且缓存中有该路径，则读取缓存以重建上下文 URL
  if (import.meta.prerender && event.path && await islandPropCache!.hasItem(event.path)) {
    // rehydrate props from cache so we can rerender island if cache does not have it any more
    url = await islandPropCache!.getItem(event.path) as string
  }
  // 从 URL 中提取组件名和 ID（格式如 /__nuxt_island/ComponentName_Hash.json）
  const componentParts = url.substring('/__nuxt_island'.length + 1).replace(ISLAND_SUFFIX_RE, '').split('_')
  const hashId = componentParts.length > 1 ? componentParts.pop() : undefined
  const componentName = componentParts.join('_')

  // TODO: Validate context
  // 获取请求上下文中的参数（GET：query；POST：body）
  const context = event.method === 'GET' ? getQuery(event) : await readBody(event)

// 构建 NuxtIslandContext 对象返回
  const ctx: NuxtIslandContext = {
    url: '/', // 默认设为根路径
    ...context, // 合并上下文参数
    id: hashId, // 设置组件的 ID
    name: componentName, // 设置组件名
    props: destr(context.props) || {}, // 安全解析 props
    slots: {}, // 初始化空插槽
    components: {}, // 初始化空组件
  }

  return ctx
}

// 判断是否定义了 app teleport 标签及其属性
const HAS_APP_TELEPORTS = !!(appTeleportTag && appTeleportAttrs.id)

// Teleport 的开始标签（如 <div id="teleports">）
const APP_TELEPORT_OPEN_TAG = HAS_APP_TELEPORTS ? `<${appTeleportTag}${propsToString(appTeleportAttrs)}>` : ''
// Teleport 的结束标签
const APP_TELEPORT_CLOSE_TAG = HAS_APP_TELEPORTS ? `</${appTeleportTag}>` : ''

// 判断 payload 请求是否为 .json 还是 .js，依据环境变量
const PAYLOAD_URL_RE = process.env.NUXT_JSON_PAYLOADS ? /^[^?]*\/_payload.json(?:\?.*)?$/ : /^[^?]*\/_payload.js(?:\?.*)?$/
// 设置 payload 文件名（根据模式）
const PAYLOAD_FILENAME = process.env.NUXT_JSON_PAYLOADS ? '_payload.json' : '_payload.js'
// 匹配整个页面 HTML 根节点的正则表达式（提取内部 HTML）
const ROOT_NODE_REGEX = new RegExp(`^<${appRootTag}[^>]*>([\\s\\S]*)<\\/${appRootTag}>$`)

// Prerender 时不需要 SSR 的特殊路由集合
const PRERENDER_NO_SSR_ROUTES = new Set(['/index.html', '/200.html', '/404.html'])

// defineRenderHandler 类似于 spring的 一个接口的处理
// 定义一个 Nuxt 的 SSR 渲染处理器（返回 HTML 或 JSON）
export default defineRenderHandler(async (event): Promise<Partial<RenderResponse>> => {
  // 获取当前 Nitro 应用实例
  const nitroApp = useNitroApp()

  // Whether we're rendering an error page
  // 检查是否是 Nuxt 的 SSR 错误页面
  const ssrError = event.path.startsWith('/__nuxt_error')
    ? getQuery(event) as unknown as NuxtPayload['error'] & { url: string }
    : null

  // 如果存在错误状态码，转换为数字
  if (ssrError && ssrError.statusCode) {
    ssrError.statusCode = Number.parseInt(ssrError.statusCode as any)
  }


  // 如果是错误页且不是内部请求，抛出 404
  if (ssrError && !('__unenv__' in event.node.req) /* allow internal fetch */) {
    throw createError({
      statusCode: 404,
      statusMessage: 'Page Not Found: /__nuxt_error',
    })
  }

  // Check for island component rendering
  // 处理 Island Component 请求

  // 判断是否为 island 模式渲染
  const isRenderingIsland = (componentIslands as unknown as boolean && event.path.startsWith('/__nuxt_island'))
  // 获取当前 island 上下文
  const islandContext = isRenderingIsland ? await getIslandContext(event) : undefined

  // 若是预渲染并命中缓存，直接返回缓存内容
  if (import.meta.prerender && islandContext && event.path && await islandCache!.hasItem(event.path)) {
    return islandCache!.getItem(event.path) as Promise<Partial<RenderResponse>>
  }

  // Request url
  let url = ssrError?.url as string || islandContext?.url || event.path

  // Whether we are rendering payload route
  // 判断是否是 payload 请求（仅非 island）
  const isRenderingPayload = process.env.NUXT_PAYLOAD_EXTRACTION && !isRenderingIsland && PAYLOAD_URL_RE.test(url)
  // 若是 payload 路由，则更新 req.url 并处理缓存
  if (isRenderingPayload) {
    url = url.substring(0, url.lastIndexOf('/')) || '/'

    event._path = url
    event.node.req.url = url
    if (import.meta.prerender && await payloadCache!.hasItem(url)) {
      return payloadCache!.getItem(url) as Promise<Partial<RenderResponse>>
    }
  }

  // Get route options (currently to apply `ssr: false`)
  // 获取路由规则、设置 Head 实例
  const routeOptions = getRouteRules(event)

  const head = createHead(unheadOptions)

  // needed for hash hydration plugin to work
  // 设置 head 用于 hash hydration
  const headEntryOptions: HeadEntryOptions = { mode: 'server' }
  if (!isRenderingIsland) {
    head.push(appHead, headEntryOptions)
  }

  // Initialize ssr context
  // 初始化 SSR 上下文
  const ssrContext: NuxtSSRContext = {
    url,
    event,
    runtimeConfig: useRuntimeConfig(event) as NuxtSSRContext['runtimeConfig'],
    noSSR:
      !!(process.env.NUXT_NO_SSR) ||
      event.context.nuxt?.noSSR ||
      (routeOptions.ssr === false && !isRenderingIsland) ||
      (import.meta.prerender ? PRERENDER_NO_SSR_ROUTES.has(url) : false),
    head,
    error: !!ssrError,
    nuxt: undefined!, /* NuxtApp */ // 将在运行时初始化
    payload: (ssrError ? { error: ssrError } : {}) as NuxtPayload,
    _payloadReducers: Object.create(null),
    modules: new Set(),
    islandContext,
  }

  // 若是预渲染并启用共享数据，设置共享缓存
  if (import.meta.prerender && process.env.NUXT_SHARED_DATA) {
    ssrContext._sharedPrerenderCache = sharedPrerenderCache!
  }

  // Whether we are prerendering route
  // 设置 Payload URL 与提取参数
  const _PAYLOAD_EXTRACTION = import.meta.prerender && process.env.NUXT_PAYLOAD_EXTRACTION && !ssrContext.noSSR && !isRenderingIsland
  const payloadURL = _PAYLOAD_EXTRACTION ? joinURL(ssrContext.runtimeConfig.app.cdnURL || ssrContext.runtimeConfig.app.baseURL, url.replace(/\?.*$/, ''), PAYLOAD_FILENAME) + '?' + ssrContext.runtimeConfig.app.buildId : undefined
  if (import.meta.prerender) {
    ssrContext.payload.prerenderedAt = Date.now()
  }

  // Render app
  // 渲染器选择（SSR / SPA）
  const renderer = (process.env.NUXT_NO_SSR || ssrContext.noSSR) ? await getSPARenderer() : await getSSRRenderer()

  // Render 103 Early Hints
  // 发送 Early Hints 103 Header
  if (process.env.NUXT_EARLY_HINTS && !isRenderingPayload && !import.meta.prerender) {
    const { link } = renderResourceHeaders({}, renderer.rendererContext)
    if (link) {
      writeEarlyHints(event, link)
    }
  }

  // 获取 Inline Styles
  if (process.env.NUXT_INLINE_STYLES && !isRenderingIsland) {
    for (const id of await getEntryIds()) {
      ssrContext.modules!.add(id)
    }
  }

  // 渲染页面 HTML
  const _rendered = await renderer.renderToString(ssrContext).catch(async (error) => {
    // We use error to bypass full render if we have an early response we can make
    if (ssrContext._renderResponse && error.message === 'skipping render') { return {} as ReturnType<typeof renderer['renderToString']> }

    // Use explicitly thrown error in preference to subsequent rendering errors
    const _err = (!ssrError && ssrContext.payload?.error) || error
    await ssrContext.nuxt?.hooks.callHook('app:error', _err)
    throw _err
  })
  await ssrContext.nuxt?.hooks.callHook('app:rendered', { ssrContext, renderResult: _rendered })

  // 渲染失败处理
  if (ssrContext._renderResponse) { return ssrContext._renderResponse }

  // Handle errors
  if (ssrContext.payload?.error && !ssrError) {
    throw ssrContext.payload.error
  }

  // Directly render payload routes
  // 处理 payload 输出与缓存
  if (isRenderingPayload) {
    const response = renderPayloadResponse(ssrContext)
    if (import.meta.prerender) {
      await payloadCache!.setItem(url, response)
    }
    return response
  }

  if (_PAYLOAD_EXTRACTION) {
    // Hint nitro to prerender payload for this route
    appendResponseHeader(event, 'x-nitro-prerender', joinURL(url.replace(/\?.*$/, ''), PAYLOAD_FILENAME))
    // Use same ssr context to generate payload for this route
    await payloadCache!.setItem(withoutTrailingSlash(url), renderPayloadResponse(ssrContext))
  }

  // Render inline styles
  // renderInlineStyles：生成 <style> 标签
  const inlinedStyles = (process.env.NUXT_INLINE_STYLES || isRenderingIsland)
    ? await renderInlineStyles(ssrContext.modules ?? [])
    : []

  const NO_SCRIPTS = process.env.NUXT_NO_SCRIPTS || routeOptions.noScripts

  // Setup head
  // 从 SSR 上下文中提取当前请求需要的资源（CSS 和 JS）
  const { styles, scripts } = getRequestDependencies(ssrContext, renderer.rendererContext)
  // 1. Preload payloads and app manifest
  // 预加载 payload 和 manifest
  if (_PAYLOAD_EXTRACTION && !NO_SCRIPTS && !isRenderingIsland) {
    head.push({
      link: [
        process.env.NUXT_JSON_PAYLOADS
          ? { rel: 'preload', as: 'fetch', crossorigin: 'anonymous', href: payloadURL } // 预加载 JSON 格式的 payload
          : { rel: 'modulepreload', crossorigin: '', href: payloadURL },  // 预加载 JavaScript payload
      ],
    }, headEntryOptions)
  }
  if (isAppManifestEnabled && ssrContext._preloadManifest) {
    // 如果启用了 App Manifest 并且 SSR 上下文中有 preload manifest
    head.push({
      link: [
        { rel: 'preload', as: 'fetch', fetchpriority: 'low', crossorigin: 'anonymous', href: buildAssetsURL(`builds/meta/${ssrContext.runtimeConfig.app.buildId}.json`) },
      ],
    }, { ...headEntryOptions, tagPriority: 'low' }) // 低优先级预加载
  }
  // 2. Styles
  // 样式处理
  if (inlinedStyles.length) {
    // 如果有内联样式，则直接添加到 head 中
    head.push({ style: inlinedStyles })
  }
  if (!isRenderingIsland || import.meta.dev) {
    // 如果不是 island 渲染，或处于开发环境
    const link: Link[] = []
    for (const resource of Object.values(styles)) {
      // Do not add links to resources that are inlined (vite v5+)
      // Vite v5 中某些资源可能已被 inline，不再重复链接
      if (import.meta.dev && 'inline' in getURLQuery(resource.file)) {
        continue
      }
      // Add CSS links in <head> for CSS files
      // - in production
      // - in dev mode when not rendering an island
      // - in dev mode when rendering an island and the file has scoped styles and is not a page

      // 以下条件下添加 CSS link：
      // - 生产模式
      // - 开发模式下，整体渲染（不是 island）
      // - 开发模式渲染 island，但样式是 scoped 且非 pages 目录
      if (!import.meta.dev || !isRenderingIsland || (resource.file.includes('scoped') && !resource.file.includes('pages/'))) {
        link.push({ rel: 'stylesheet', href: renderer.rendererContext.buildAssetsURL(resource.file), crossorigin: '' })
      }
    }
    if (link.length) {
      // 如果有样式链接，添加到 head
      head.push({ link }, headEntryOptions)
    }
  }

  // 3. Response for component islands
  if (isRenderingIsland && islandContext) {
    const islandHead: SerializableHead = {}
    // 合并已有 head 中的所有 entry
    for (const entry of head.entries.values()) {
      for (const [key, value] of Object.entries(resolveUnrefHeadInput(entry.input as any) as SerializableHead)) {
        const currentValue = islandHead[key as keyof SerializableHead]
        if (Array.isArray(currentValue)) {
          // 如果已有同类 key，追加新值
          currentValue.push(...value)
        }
        islandHead[key as keyof SerializableHead] = value
      }
    }

    // TODO: remove for v4
    // 兼容处理：确保 link 和 style 存在
    islandHead.link ||= []
    islandHead.style ||= []

    // 构造 island 响应对象
    const islandResponse: NuxtIslandResponse = {
      id: islandContext.id,
      head: islandHead,
      html: getServerComponentHTML(_rendered.html),
      components: getClientIslandResponse(ssrContext),
      slots: getSlotIslandResponse(ssrContext),
    }

    // 触发 hook，可供插件扩展
    await nitroApp.hooks.callHook('render:island', islandResponse, { event, islandContext })

    const response = {
      body: JSON.stringify(islandResponse, null, 2),
      statusCode: getResponseStatus(event),
      statusMessage: getResponseStatusText(event),
      headers: {
        'content-type': 'application/json;charset=utf-8',
        'x-powered-by': 'Nuxt',
      },
    } satisfies RenderResponse
    if (import.meta.prerender) {
      // 预渲染时缓存岛屿组件响应数据
      await islandCache!.setItem(`/__nuxt_island/${islandContext!.name}_${islandContext!.id}.json`, response)
      await islandPropCache!.setItem(`/__nuxt_island/${islandContext!.name}_${islandContext!.id}.json`, event.path)
    }
    return response
  }

  if (!NO_SCRIPTS) {
    // 4. Resource Hints
    // 资源提示（资源优化）
    // TODO: add priorities based on Capo
    head.push({
      link: getPreloadLinks(ssrContext, renderer.rendererContext) as Link[],
    }, headEntryOptions)
    head.push({
      link: getPrefetchLinks(ssrContext, renderer.rendererContext) as Link[],
    }, headEntryOptions)
    // 5. Payloads
    // Payload 脚本
    head.push({
      script: _PAYLOAD_EXTRACTION
        ? process.env.NUXT_JSON_PAYLOADS
          ? renderPayloadJsonScript({ ssrContext, data: splitPayload(ssrContext).initial, src: payloadURL })
          : renderPayloadScript({ ssrContext, data: splitPayload(ssrContext).initial, src: payloadURL })
        : process.env.NUXT_JSON_PAYLOADS
          ? renderPayloadJsonScript({ ssrContext, data: ssrContext.payload })
          : renderPayloadScript({ ssrContext, data: ssrContext.payload }),
    }, {
      ...headEntryOptions,
      // this should come before another end of body scripts
      tagPosition: 'bodyClose',
      tagPriority: 'high',
    })
  }

  // 6. Scripts
  // JS 脚本资源
  if (!routeOptions.noScripts) {
    head.push({
      script: Object.values(scripts).map(resource => (<Script> {
        type: resource.module ? 'module' : null,
        src: renderer.rendererContext.buildAssetsURL(resource.file),
        defer: resource.module ? null : true,
        // if we are rendering script tag payloads that import an async payload
        // we need to ensure this resolves before executing the Nuxt entry
        tagPosition: (_PAYLOAD_EXTRACTION && !process.env.NUXT_JSON_PAYLOADS) ? 'bodyClose' : 'head',
        crossorigin: '',
      })),
    }, headEntryOptions)
  }

  // remove certain tags for nuxt islands
  // 处理最终 HTML 结构与属性
// 渲染最终的 <head> 与 <body> 中的内容（包括标签和属性）
  const { headTags, bodyTags, bodyTagsOpen, htmlAttrs, bodyAttrs } = await renderSSRHead(head, renderSSRHeadOptions)

  // Create render context
  // 构造最终 HTML 渲染上下文
  const htmlContext: NuxtRenderHTMLContext = {
    island: isRenderingIsland,
    htmlAttrs: htmlAttrs ? [htmlAttrs] : [],
    head: normalizeChunks([headTags]),
    bodyAttrs: bodyAttrs ? [bodyAttrs] : [],
    bodyPrepend: normalizeChunks([bodyTagsOpen, ssrContext.teleports?.body]),
    body: [
      componentIslands ? replaceIslandTeleports(ssrContext, _rendered.html) : _rendered.html,
      APP_TELEPORT_OPEN_TAG + (HAS_APP_TELEPORTS ? joinTags([ssrContext.teleports?.[`#${appTeleportAttrs.id}`]]) : '') + APP_TELEPORT_CLOSE_TAG,
    ],
    bodyAppend: [bodyTags],
  }

  // Allow hooking into the rendered result
  // 提供钩子供插件修改最终 HTML 内容
  await nitroApp.hooks.callHook('render:html', htmlContext, { event })

  // Construct HTML response
  // 最终构建 HTML 返回
  const response = {
    body: renderHTMLDocument(htmlContext),
    statusCode: getResponseStatus(event),
    statusMessage: getResponseStatusText(event),
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'x-powered-by': 'Nuxt',
    },
  } satisfies RenderResponse

  return response
})

// 过滤掉 undefined/null 元素，并去除每个字符串前后的空格
function normalizeChunks (chunks: (string | undefined)[]) {
  return chunks.filter(Boolean).map(i => i!.trim())
}

// 将多个 HTML 片段拼接为一个完整字符串
function joinTags (tags: Array<string | undefined>) {
  return tags.join('')
}

// 将 HTML 属性数组拼接为一个字符串，例如 ["lang=\"en\"", "dir=\"ltr\""] -> ' lang="en" dir="ltr"'
function joinAttrs (chunks: string[]) {
  if (chunks.length === 0) { return '' }
  return ' ' + chunks.join(' ')
}

// 构建完整的 HTML 文档结构，插入 head、body 和相关属性
function renderHTMLDocument (html: NuxtRenderHTMLContext) {
  return '<!DOCTYPE html>' +
    `<html${joinAttrs(html.htmlAttrs)}>` + // 插入 <html> 标签及其属性
    `<head>${joinTags(html.head)}</head>` + // 插入 <head> 标签及其内容
    `<body${joinAttrs(html.bodyAttrs)}>${joinTags(html.bodyPrepend)}${joinTags(html.body)}${joinTags(html.bodyAppend)}</body>` + // <body> 标签及其前/后/主要内容
    '</html>'
}

// 获取已使用模块对应的 CSS 内容并返回内联的 style 标签数组
async function renderInlineStyles (usedModules: Set<string> | string[]): Promise<Style[]> {
  // 获取所有可用的 SSR 样式映射
  const styleMap = await getSSRStyles()
  // 使用 Set 去重
  const inlinedStyles = new Set<string>()
  for (const mod of usedModules) {
    if (mod in styleMap && styleMap[mod]) {
      // 异步调用该模块对应的样式生成函数
      for (const style of await styleMap[mod]()) {
        // 添加到集合中
        inlinedStyles.add(style)
      }
    }
  }
  // 将 style 字符串包装为 { innerHTML } 格式的数组
  return Array.from(inlinedStyles).map(style => ({ innerHTML: style }))
}

/**
 * remove the root node from the html body
 * 从 HTML 字符串中提取出服务端组件的 HTML 内容，去掉根节点包裹
 */
function getServerComponentHTML (body: string): string {
  // 正则提取根节点内的内容
  const match = body.match(ROOT_NODE_REGEX)
  // 如果匹配成功，返回提取的内容，否则原样返回
  return match?.[1] || body
}

// 服务器端标记 slot 用于识别岛屿组件的占位内容
const SSR_SLOT_TELEPORT_MARKER = /^uid=([^;]*);slot=(.*)$/
// 客户端岛屿组件标记
const SSR_CLIENT_TELEPORT_MARKER = /^uid=([^;]*);client=(.*)$/
// 客户端 slot 标记
const SSR_CLIENT_SLOT_MARKER = /^island-slot=([^;]*);(.*)$/

// 提取岛屿组件的 slot 响应（服务端渲染时）
function getSlotIslandResponse (ssrContext: NuxtSSRContext): NuxtIslandResponse['slots'] {
  // 如果没有岛屿上下文或没有 slot，直接返回 undefined
  if (!ssrContext.islandContext || !Object.keys(ssrContext.islandContext.slots).length) { return undefined }
  const response: NuxtIslandResponse['slots'] = {}
  for (const [name, slot] of Object.entries(ssrContext.islandContext.slots)) {
    response[name] = {
      // 保留原始 slot 数据
      ...slot,
      fallback: ssrContext.teleports?.[`island-fallback=${name}`],
    }
  }
  return response
}

// 提取客户端岛屿组件响应（用于客户端复用组件 HTML）
function getClientIslandResponse (ssrContext: NuxtSSRContext): NuxtIslandResponse['components'] {
  // 如果没有组件，直接返回 undefined
  if (!ssrContext.islandContext || !Object.keys(ssrContext.islandContext.components).length) { return undefined }
  const response: NuxtIslandResponse['components'] = {}

  for (const [clientUid, component] of Object.entries(ssrContext.islandContext.components)) {
    // remove teleport anchor to avoid hydration issues
    // 获取 HTML 内容，移除 teleport 的锚点注释（避免客户端复用时出错）
    const html = ssrContext.teleports?.[clientUid]?.replaceAll('<!--teleport start anchor-->', '') || ''
    response[clientUid] = {
      // 保留原始组件信息
      ...component,
      // 注入清理过的 HTML
      html,
      // 注入 slot HTML
      slots: getComponentSlotTeleport(clientUid, ssrContext.teleports ?? {}),
    }
  }
  return response
}

// 获取组件对应的所有 slot 的 HTML 内容
function getComponentSlotTeleport (clientUid: string, teleports: Record<string, string>) {
  const entries = Object.entries(teleports)
  const slots: Record<string, string> = {}

  for (const [key, value] of entries) {
    const match = key.match(SSR_CLIENT_SLOT_MARKER)
    if (match) {
      const [, id, slot] = match
      if (!slot || clientUid !== id) { continue }  // 如果不匹配 uid 跳过
      slots[slot] = value
    }
  }
  return slots
}

// 替换 HTML 中的岛屿组件 teleport 占位符，插入实际内容
function replaceIslandTeleports (ssrContext: NuxtSSRContext, html: string) {
  const { teleports, islandContext } = ssrContext

  // 如果有 islandContext 说明是嵌套 SSR，不进行替换
  if (islandContext || !teleports) { return html }
  for (const key in teleports) {
    const matchClientComp = key.match(SSR_CLIENT_TELEPORT_MARKER)
    if (matchClientComp) {
      const [, uid, clientId] = matchClientComp
      if (!uid || !clientId) { continue }
      // 正则匹配包含岛屿标记的元素，追加 HTML 内容
      html = html.replace(new RegExp(` data-island-uid="${uid}" data-island-component="${clientId}"[^>]*>`), (full) => {
        return full + teleports[key]
      })
      continue
    }
    const matchSlot = key.match(SSR_SLOT_TELEPORT_MARKER)
    if (matchSlot) {
      const [, uid, slot] = matchSlot
      if (!uid || !slot) { continue }
      html = html.replace(new RegExp(` data-island-uid="${uid}" data-island-slot="${slot}"[^>]*>`), (full) => {
        return full + teleports[key]
      })
    }
  }
  return html
}
