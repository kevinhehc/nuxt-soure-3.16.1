import { createHead as createClientHead, renderDOMHead } from '@unhead/vue/client'
import { defineNuxtPlugin } from '#app/nuxt'

// @ts-expect-error virtual file
import unheadOptions from '#build/unhead-options.mjs'

// 插件在 Nuxt 启动时注册 unhead 实例，挂载到 vueApp 上并处理 SSR 与客户端的 <head> 渲染时机，包括页面切换、Suspense 解析和错误恢复。

export default defineNuxtPlugin({
  // name: 插件名称为 nuxt:head；
  // enforce: 'pre': 最早执行，确保 head 在任何页面加载前生效；
  // setup(nuxtApp): 插件入口函数，接收 Nuxt 应用实例。
  name: 'nuxt:head',
  enforce: 'pre',
  setup (nuxtApp) {
    // SSR 时：直接从 ssrContext.head 中取（由 Nuxt 渲染器注入）；
    // 客户端时：使用 @unhead/vue 的 createClientHead() 创建实例；
    // 最终通过 vueApp.use(head) 安装到应用中，供组件树使用 useHead() 等组合式 API。
    const head = import.meta.server
      ? nuxtApp.ssrContext!.head
      : createClientHead(unheadOptions)
    // nuxt.config appHead is set server-side within the renderer
    nuxtApp.vueApp.use(head)

    if (import.meta.client) {
      // pause dom updates until page is ready and between page transitions
      let pauseDOMUpdates = true
      const syncHead = async () => {
        pauseDOMUpdates = false
        await renderDOMHead(head)
      }
      head.hooks.hook('dom:beforeRender', (context) => { context.shouldRender = !pauseDOMUpdates })
      nuxtApp.hooks.hook('page:start', () => { pauseDOMUpdates = true })
      // wait for new page before unpausing dom updates (triggered after suspense resolved)
      nuxtApp.hooks.hook('page:finish', () => {
        // app:suspense:resolve hook will unpause the DOM
        if (!nuxtApp.isHydrating) { syncHead() }
      })
      // unpause on error
      nuxtApp.hooks.hook('app:error', syncHead)
      // unpause the DOM once the mount suspense is resolved
      nuxtApp.hooks.hook('app:suspense:resolve', syncHead)
    }
  },
})

// 生命周期钩子控制 DOM 更新节奏
//
// Hook	                含义	          行为
// page:start	          页面开始加载	  暂停 DOM 更新
// page:finish	        页面加载完成	  渲染 <head> 内容
// app:error	          应用出错	      立即刷新 <head>
// app:suspense:resolve	Suspense 完成	渲染 <head>
// dom:beforeRender	    DOM 渲染前	    设置 context.shouldRender = false 时会跳过更新
