import { createError, showError } from '#app/composables/error'
import { useNuxtApp } from '#app/nuxt'
import { defineNuxtRouteMiddleware, useRouter } from '#app/composables/router'

// 定义一个 异步路由中间件，接受即将跳转的路由对象 to。
// 使用方式示例：
// export default definePageMeta({
//   validate: async (route) => {
//     return await isUserAuthorized(route.params.id)
//   }
// })
export default defineNuxtRouteMiddleware(async (to) => {
  // 如果当前页面的路由没有定义 meta.validate 函数，直接跳过。
  if (!to.meta?.validate) { return }

  // 获取 Nuxt 实例和路由器
  const nuxtApp = useNuxtApp()
  const router = useRouter()

  // validate 可以返回：
  // true：校验通过，继续跳转；
  // false、null、或者返回对象（含 statusCode, statusMessage）：视为校验失败。
  const result = await Promise.resolve(to.meta.validate(to))
  if (result === true) {
    return
  }

  // 创建一个 NuxtError 对象，用于后续显示错误页。
  const error = createError({
    statusCode: (result && result.statusCode) || 404,
    statusMessage: (result && result.statusMessage) || `Page Not Found: ${to.fullPath}`,
    data: {
      path: to.fullPath,
    },
  })

  // 监听 router.beforeResolve 拦截当前跳转。
  // 如果确实是当前目标路由，则：
  // 阻止导航（return false）
  // 在 afterEach 中触发 showError()，显示错误页
  // 手动把错误路径 pushState 到浏览器历史记录中，避免用户点击“后退”按钮时失效
  const unsub = router.beforeResolve((final) => {
    unsub()
    if (final === to) {
      const unsub = router.afterEach(async () => {
        unsub()
        await nuxtApp.runWithContext(() => showError(error))
        // We pretend to have navigated to the invalid route so
        // that the user can return to the previous page with
        // the back button.
        window?.history.pushState({}, '', to.fullPath)
      })
      // We stop the navigation immediately before it resolves
      // if there is no other route matching it.
      return false
    }
  })
})
