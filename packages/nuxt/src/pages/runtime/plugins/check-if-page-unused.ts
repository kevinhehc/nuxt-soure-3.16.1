import { nextTick } from 'vue'
import { defineNuxtPlugin } from '#app/nuxt'
import { onNuxtReady } from '#app/composables/ready'
import { useError } from '#app/composables/error'

export default defineNuxtPlugin({
  name: 'nuxt:checkIfPageUnused',
  setup (nuxtApp) {
    // 插件在初始化时运行。
    // 获取 Nuxt 的全局错误状态（防止在报错页面时输出不必要的警告）。
    const error = useError()

    // 如果没有报错页面 (!error.value)
    // 并且 Nuxt 自动设置的 _isNuxtPageUsed 标志为 false（代表 <NuxtPage /> 没有出现在页面中）
    //
    // 就打印一个警告️：
    //    提示开发者忘记用 <NuxtPage />
    //    或者 用了错误的 <RouterView />（不兼容 Nuxt 的 pages 路由系统）
    //    如果是刻意不用 pages 功能，应该在 nuxt.config 里设置 pages: false
    function checkIfPageUnused () {
      if (!error.value && !nuxtApp._isNuxtPageUsed) {
        console.warn(
          '[nuxt] Your project has pages but the `<NuxtPage />` component has not been used.' +
          ' You might be using the `<RouterView />` component instead, which will not work correctly in Nuxt.' +
          ' You can set `pages: false` in `nuxt.config` if you do not wish to use the Nuxt `vue-router` integration.',
        )
      }
    }

    // 如果是 SSR 服务端：
    //    等到 app:rendered 钩子触发后再检查。
    //    使用 nextTick() 是为了等 DOM 渲染完。
    // 如果是客户端：
    //    使用 onNuxtReady() 来延迟到 Nuxt 客户端完全启动后再检查。
    if (import.meta.server) {
      nuxtApp.hook('app:rendered', ({ renderResult }) => {
        if (renderResult?.html) {
          nextTick(checkIfPageUnused)
        }
      })
    } else {
      onNuxtReady(checkIfPageUnused)
    }
  },
  // 表示这个插件不适用于 island mode（即非部分渲染组件的上下文）。
  // Island Mode 是 Nuxt 为优化组件渲染而设计的模式，在这里只排除它以避免误判。
  env: {
    islands: false,
  },
})
