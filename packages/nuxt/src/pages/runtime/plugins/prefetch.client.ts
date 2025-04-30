import { hasProtocol } from 'ufo'
import { toArray } from '../utils'
import { defineNuxtPlugin } from '#app/nuxt'
import { useRouter } from '#app/composables/router'
// @ts-expect-error virtual file
import layouts from '#build/layouts'
// @ts-expect-error virtual file
import { namedMiddleware } from '#build/middleware'

// 在页面跳转前或链接预取时提前加载布局 (layout) 和中间件 (middleware)，提高页面响应速度。

export default defineNuxtPlugin({
  name: 'nuxt:prefetch',
  setup (nuxtApp) {
    const router = useRouter()

    // Force layout prefetch on route changes
    // 拿到 Vue Router 实例，用于后续路径解析与跳转监听。
    nuxtApp.hooks.hook('app:mounted', () => {
      // 当整个 app 挂载后（即客户端 ready）：
      // 使用 router.beforeEach() 添加页面跳转前钩子。
      // 提前执行该页面对应的 layout() 函数（layout 是动态导入的）。
      router.beforeEach(async (to) => {
        const layout = to?.meta?.layout
        if (layout && typeof layouts[layout] === 'function') {
          await layouts[layout]()
        }
      })
    })


    // Prefetch layouts & middleware
    // 当用户 hover 一个 <NuxtLink to="/xxx">，Nuxt 会触发 link:prefetch。
    // 如果 URL 是 HTTP(s) 等外链（有协议头），跳过。
    // 用 router.resolve(url) 解析成内部路由对象。
    // 取出对应的 layout 和 middleware。
    nuxtApp.hooks.hook('link:prefetch', (url) => {
      if (hasProtocol(url)) { return }
      const route = router.resolve(url)
      if (!route) { return }
      const layout = route.meta.layout
      let middleware = toArray(route.meta.middleware)
      middleware = middleware.filter(m => typeof m === 'string')

      for (const name of middleware) {
        if (typeof namedMiddleware[name] === 'function') {
          namedMiddleware[name]()
        }
      }

      if (layout && typeof layouts[layout] === 'function') {
        layouts[layout]()
      }
    })
  },
})
