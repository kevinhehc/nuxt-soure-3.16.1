import { useNuxtApp } from '../nuxt'
import { requestIdleCallback } from '../compat/idle-callback'

/** @since 3.1.0 */
// 在客户端 Nuxt 应用完全就绪时，安全地注册一个回调函数执行。
// 而且还做了细致优化：确保在浏览器 空闲时（requestIdleCallback）调用，避免影响首次渲染性能！
// 我来逐行给你超详细讲解，帮你彻底理解它的设计思路：
export const onNuxtReady = (callback: () => any) => {
  // 如果当前运行在服务器端 (SSR)，直接返回，不注册任何回调。
  // 因为服务器不会触发 "Nuxt Ready" 这种浏览器生命周期。
  if (import.meta.server) { return }

  const nuxtApp = useNuxtApp()
  if (nuxtApp.isHydrating) {
    // 判断当前 Nuxt 应用是否正在Hydration阶段：
    // Hydration指的是：客户端把服务器渲染的静态 HTML 变成活的 Vue 应用的过程。
    // 如果还在 Hydration 中，不能马上执行 callback，要等应用 "激活" 完成。

    // 注册一次性的 app:suspense:resolve 钩子。
    // 当所有 Suspense 边界 (异步组件、数据加载) 完成后，才执行回调。
    // 而且放到 requestIdleCallback 里延迟执行，在浏览器空闲时间执行，避免阻塞 UI。
    nuxtApp.hooks.hookOnce('app:suspense:resolve', () => { requestIdleCallback(() => callback()) })
  } else {
    // 如果不是 Hydration（比如是纯 SPA 导航、冷启动之后的页面切换），
    // 直接在空闲时间调 callback。
    requestIdleCallback(() => callback())
  }
}
