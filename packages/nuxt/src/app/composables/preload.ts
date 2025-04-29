import type { Component } from 'vue'
import type { RouteLocationRaw, Router } from 'vue-router'
import { useNuxtApp } from '../nuxt'
import { toArray } from '../utils'
import { useRouter } from './router'

// 在用户还没跳转或还没渲染前，把需要用到的异步组件提前加载到客户端。
// （减少切换等待时间，提升页面流畅性！）

/**
 * Preload a component or components that have been globally registered.
 * @param components Pascal-cased name or names of components to prefetch
 * @since 3.0.0
 */
// 调用 preloadComponents(names)
//     ↓
// 遍历全局注册组件
//     ↓
// 如果是异步组件
//         → 调用 __asyncLoader() 强制预加载
export const preloadComponents = async (components: string | string[]) => {
  // 只在客户端执行（因为组件加载是浏览器行为）。
  // 拿到 nuxtApp.vueApp，可以访问全局注册的组件。
  if (import.meta.server) { return }
  const nuxtApp = useNuxtApp()

  // 保证 components 是数组，即使只传了一个名字。
  components = toArray(components)

  // 找到对应的组件（要求是全局注册的 PascalCase 名字）。
  // 调用 _loadAsyncComponent(component)：
  // 如果是异步组件 (defineAsyncComponent) 就强制触发加载。
  // 否则忽略。
  // 这样在需要前，异步组件就已经下载好了！
  await Promise.all(components.map((name) => {
    const component = nuxtApp.vueApp._context.components[name]
    if (component) {
      return _loadAsyncComponent(component)
    }
  }))
}

/**
 * Prefetch a component or components that have been globally registered.
 * @param components Pascal-cased name or names of components to prefetch
 * @since 3.0.0
 */
// 目前实际上只是 简单调用 preloadComponents。
// 将来可能区别对待 "prefetch"（低优先级）和 "preload"（高优先级）。
// 现在可以把它们理解为一回事。
export const prefetchComponents = (components: string | string[]) => {
  if (import.meta.server) { return }

  // TODO
  return preloadComponents(components)
}

// --- Internal ---

//
function _loadAsyncComponent (component: Component) {
  // 检查：
  // 如果这个组件是异步的（有 __asyncLoader 属性）
  // 并且还没有加载完成（!__asyncResolved）
  // 那就直接调用 __asyncLoader() 强制触发加载。
  // 非常简单暴力，兼容 Vue 3 内部异步组件机制。
  if ((component as any)?.__asyncLoader && !(component as any).__asyncResolved) {
    return (component as any).__asyncLoader()
  }
}

/** @since 3.0.0 */
// 给定一个路由地址 to（可以是字符串或对象），
// 自动预加载这个路由下需要的所有组件！
// 调用 preloadRouteComponents(route)
//     ↓
// 解析 route
//     ↓
// 找到 matched 组件
//     ↓
// 触发组件加载函数
//     ↓
// 限制并发，防止超载
export async function preloadRouteComponents (to: RouteLocationRaw, router: Router & { _routePreloaded?: Set<string>, _preloadPromises?: Array<Promise<unknown>> } = useRouter()): Promise<void> {
  // 组件加载是浏览器行为，服务器端跳过。
  if (import.meta.server) { return }

  // 用 Router 的 resolve API，拿到：
  // 真实路径
  // 匹配到的所有路由记录（matched）。
  const { path, matched } = router.resolve(to)

  if (!matched.length) { return }
  router._routePreloaded ||= new Set()

  // 防止重复预加载
  // 用 Set 记录已经预加载过的路径。
  // 同一个路径不会重复预加载。
  if (router._routePreloaded.has(path)) { return }

  const promises = router._preloadPromises ||= []

  // 如果正在进行的 preload promise 太多（>4个），
  // 就等现有的 promise 全部完成，再递归继续 preload。
  // 控制网络并发，避免浏览器卡死。
  if (promises.length > 4) {
    // Defer adding new preload requests until the existing ones have resolved
    return Promise.all(promises).then(() => preloadRouteComponents(to, router))
  }

  router._routePreloaded.add(path)

  // 找到每个 matched 路由里的 default 组件（一般是 pages 下的页面）。
  const components = matched
    .map(component => component.components?.default)
    .filter(component => typeof component === 'function')

  // 调用组件的函数（其实就是 defineAsyncComponent 返回的加载器），开始异步加载组件。
  // 错误 catch 掉，防止加载失败影响整体流程。
  // 完成后从 promises 列表里删掉，保持 promises 数量更新。
  for (const component of components) {
    const promise = Promise.resolve((component as () => unknown)())
      .catch(() => {})
      .finally(() => promises.splice(promises.indexOf(promise)))
    promises.push(promise)
  }

  await Promise.all(promises)
}
