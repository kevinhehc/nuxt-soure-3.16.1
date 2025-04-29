import { createApp, createSSRApp, nextTick } from 'vue'
import type { App } from 'vue'

// This file must be imported first as we set globalThis.$fetch via this import
// @ts-expect-error virtual file
import '#build/fetch.mjs'

import { applyPlugins, createNuxtApp } from './nuxt'
import type { CreateOptions } from './nuxt'

import { createError } from './composables/error'

// @ts-expect-error virtual file
import '#build/css'
// @ts-expect-error virtual file
import plugins from '#build/plugins'
// @ts-expect-error virtual file
import RootComponent from '#build/root-component.mjs'
// @ts-expect-error virtual file
import { appId, appSpaLoaderAttrs, multiApp, spaLoadingTemplateOutside, vueAppRootContainer } from '#build/nuxt.config.mjs'

// 服务器端渲染时，Nuxt 是怎么创建 Vue 应用，并且怎么执行插件、触发生命周期钩子、处理错误的。
// 声明一个 entry 函数变量。
// 类型是：
// 参数是可选的 ssrContext（服务器渲染上下文对象）
// 返回值是 Promise<VueApp>（Vue 3 的 App 实例）
let entry: (ssrContext?: CreateOptions['ssrContext']) => Promise<App<Element>>

// 只有在服务器端（SSR环境）才执行下面的定义。
if (import.meta.server) {
  // 定义 entry 这个函数。
  // 给它取名叫 createNuxtAppServer。
  // 参数是 ssrContext，表示当前这一次请求对应的服务器上下文。
  entry = async function createNuxtAppServer (ssrContext: CreateOptions['ssrContext']) {
    // 创建一个新的 Vue 应用实例。
    // 以 RootComponent（通常是 Nuxt 内部的 App.vue 包装）作为根组件。
    const vueApp = createApp(RootComponent)

    // 调用 createNuxtApp，生成一个 Nuxt 应用实例。
    // 把刚刚创建好的 vueApp 和 ssrContext 传进去。
    // 这样 nuxt 对象就关联了：
    // Vue 应用
    // 当前请求上下文
    // payload（用来注入页面需要的数据，比如 asyncData、state）
    // 插件系统（hooks）
    const nuxt = createNuxtApp({ vueApp, ssrContext })

    try {
      // 执行 Nuxt 的所有插件。
      // applyPlugins 会按照定义的顺序加载并执行每个插件，比如：
      // 运行插件注册到 app
      // 初始化插件逻辑（pinia, i18n, runtime modules 等）
      await applyPlugins(nuxt, plugins)
      // 插件全部加载完以后，手动触发 Nuxt 的生命周期钩子 app:created。
      // 这时候插件、vueApp、nuxtApp 全部组装完毕。
      // 允许插件在这里注册自己的逻辑（比如 setup 运行、useHead 注册等等）。
      await nuxt.hooks.callHook('app:created', vueApp)
    } catch (error) {
      // 如果上面在插件执行或者 hook 触发中出现异常，就进入 catch。
      // 触发 app:error 生命周期钩子，通知所有监听者有错误发生。
      // 比如：
      // 自定义错误处理插件
      // 错误日志系统（Sentry、Datadog）
      // SSR error recovery
      await nuxt.hooks.callHook('app:error', error)

      // 如果 payload.error 还没有错误信息，
      // 就把当前的错误用 createError 标准封装后，挂到 payload.error。
      // 这样客户端也能拿到服务器端出现的错误信息。
      nuxt.payload.error ||= createError(error as any)
    }

    // 这句非常特殊！
    // 有些情况下（比如 server middleware 直接返回了响应）：
    // ssrContext._renderResponse 会被设置。
    // 如果已经有响应内容了，抛出一个错误 skipping render，终止 Nuxt 的正常渲染流程。
    // 优化点：避免白白走 Vue 组件渲染，提高性能。
    if (ssrContext?._renderResponse) { throw new Error('skipping render') }

    return vueApp
  }
}


// Nuxt 在浏览器里真正跑起来的主入口逻辑。
if (import.meta.client) {
  // TODO: temporary webpack 5 HMR fix
  // https://github.com/webpack-contrib/webpack-hot-middleware/issues/390
  if (import.meta.dev && import.meta.webpackHot) {
    // 如果是开发环境 (import.meta.dev)，而且用了 webpack (import.meta.webpackHot)，
    // 注册热更新 accept。
    // 背景： Webpack 5 HMR 在某些场景下需要手动 accept，防止全局 reload。
    // TODO 注释说明这是临时修复。
    import.meta.webpackHot.accept()
  }

  // eslint-disable-next-line
  // 声明一个 promise，缓存 Vue App 启动过程。
  // 确保只启动一次，后续可以 await 这个 promise。
  let vueAppPromise: Promise<App<Element>>

  // 定义 entry 函数，叫 initApp，返回一个 Vue App。
  // 这是整个客户端启动的主逻辑。
  entry = async function initApp () {

    // 防止重复初始化
    if (vueAppPromise) { return vueAppPromise }

    // 检查 window 上是否有 SSR 渲染过的标记：
    // window.__NUXT__.serverRendered
    // 或者 __NUXT_DATA__.dataset.ssr === 'true'
    // 支持多应用模式 (multiApp 多个 appId)。
    // **目的：**判断这次要不要 createSSRApp，还是直接 createApp。
    const isSSR = Boolean(
      (multiApp ? window.__NUXT__?.[appId] : window.__NUXT__)?.serverRendered ??
      (multiApp ? document.querySelector(`[data-nuxt-data="${appId}"]`) as HTMLElement : document.getElementById('__NUXT_DATA__'))?.dataset.ssr === 'true',
    )

    // 如果是 SSR Hydration：
    //                      用 createSSRApp
    // 如果是纯 SPA：
    //                      用 createApp
    const vueApp = isSSR ? createSSRApp(RootComponent) : createApp(RootComponent)

    // 创建 Nuxt 应用实例，关联 Vue app。
    const nuxt = createNuxtApp({ vueApp })

    // 封装一个统一的错误处理器。
    // 捕获错误后：
    // 调用 app:error hook
    // 把错误挂到 payload.error 上
    async function handleVueError (error: any) {
      await nuxt.callHook('app:error', error)
      nuxt.payload.error ||= createError(error as any)
    }

    // 全局拦截 Vue 组件中的错误。
    vueApp.config.errorHandler = handleVueError
    // If the errorHandler is not overridden by the user, we unset it after the app is hydrated
    // 如果用户自己没覆盖 errorHandler，在 suspense resolve（组件挂载完成）后取消默认的 Nuxt errorHandler。
    // 在 suspense resolve 后清除默认 errorHandler（防止干扰用户自己设置）
    nuxt.hook('app:suspense:resolve', () => {
      if (vueApp.config.errorHandler === handleVueError) { vueApp.config.errorHandler = undefined }
    })

    // 如果是纯 SPA 加载模式：
    // 加载时挂了一个 loading spinner
    // 那么在 suspense resolve 后，移除 loading spinner 节点。
    if (spaLoadingTemplateOutside && !isSSR && appSpaLoaderAttrs.id) {
      // Remove spa loader if present
      nuxt.hook('app:suspense:resolve', () => {
        document.getElementById(appSpaLoaderAttrs.id)?.remove()
      })
    }

    // 加载并应用所有插件。
    // 如果出错，用 handleVueError 捕获。
    try {
      await applyPlugins(nuxt, plugins)
    } catch (err) {
      handleVueError(err)
    }

    // 依次触发 Nuxt 生命周期：
    // app:created
    // app:beforeMount
    // mount Vue 应用到 DOM
    // app:mounted
    // 最后 await 一个 nextTick()，确保 Vue 完成 patch。
    try {
      await nuxt.hooks.callHook('app:created', vueApp)
      await nuxt.hooks.callHook('app:beforeMount', vueApp)
      vueApp.mount(vueAppRootContainer)
      await nuxt.hooks.callHook('app:mounted', vueApp)
      await nextTick()
    } catch (err) {
      handleVueError(err)
    }

    return vueApp
  }

  // 立即调用 entry()
  // 把 promise 保存下来
  // 如果初始化出错，打印错误并抛出
  vueAppPromise = entry().catch((error: unknown) => {
    console.error('Error while mounting app:', error)
    throw error
  })
}

export default (ssrContext?: CreateOptions['ssrContext']) => entry(ssrContext)
