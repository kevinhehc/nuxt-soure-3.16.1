import { defineNuxtPlugin } from '../nuxt'
import { reloadNuxtApp } from '../composables/chunk'
import { addRouteMiddleware } from '../composables/router'

// 在页面跳转过程中如果遇到 chunkError（静态资源丢失或版本不一致），立刻刷新页面，而不是等到下次导航。

// 定义一个小包装函数 reloadNuxtApp_。
// 给定一个 path，调用 reloadNuxtApp() 并带上 { persistState: true }。
// 保证页面刷新但用户数据状态不会丢失。
const reloadNuxtApp_ = (path: string) => { reloadNuxtApp({ persistState: true, path }) }

// See https://github.com/nuxt/nuxt/issues/23612 for more context
// 发生 chunk 错误时立即刷新，而不是拖到下次导航。
export default defineNuxtPlugin({
  name: 'nuxt:chunk-reload-immediate',
  setup (nuxtApp) {
    // Remember `to.path` when navigating to a new path: A `chunkError` may occur during navigation, we then want to then reload at `to.path`
    // 声明一个变量 currentlyNavigationTo。
    // 注册一个 全局路由中间件，每次路由跳转开始时记录 to.path。
    // 这样即使跳转还没完成（比如 chunk 加载中出错了），也知道目标是哪里。
    let currentlyNavigationTo: null | string = null
    addRouteMiddleware((to) => {
      currentlyNavigationTo = to.path
    })

    // Reload when a `chunkError` is thrown
    // 如果有 chunkError 错误发生：
    // 优先使用正在跳转的目标 currentlyNavigationTo。
    // 如果跳转目标未知，则使用当前路由 nuxtApp._route.path。
    // 直接调用 reloadNuxtApp_，立刻刷新页面！
    nuxtApp.hook('app:chunkError', () => reloadNuxtApp_(currentlyNavigationTo ?? nuxtApp._route.path))

    // Reload when the app manifest updates
    // 如果检测到构建版本变了（比如后端部署了新版本），
    // 同样立刻刷新当前页面。
    // 不等用户跳转或手动操作。
    nuxtApp.hook('app:manifest:update', () => reloadNuxtApp_(nuxtApp._route.path))
  },
})
