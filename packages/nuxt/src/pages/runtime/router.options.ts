import type { RouteLocationNormalized, RouterScrollBehavior } from 'vue-router'
import type { RouterConfig } from 'nuxt/schema'
import { useNuxtApp } from '#app/nuxt'
import { isChangingPage } from '#app/components/utils'
import { useRouter } from '#app/composables/router'
// @ts-expect-error virtual file
import { appPageTransition as defaultPageTransition } from '#build/nuxt.config.mjs'

// 模块导出一个默认对象 <RouterConfig>，作为 router.options 的一部分，被 Nuxt 内部用于配置 Vue Router 的滚动行为。

type ScrollPosition = Awaited<ReturnType<RouterScrollBehavior>>

// Default router options
// https://router.vuejs.org/api/#routeroptions
export default <RouterConfig> {
  // to：即将进入的路由对象。
  // from：当前离开的路由对象。
  // savedPosition：浏览器前进/后退时自动保存的位置（仅用于 popstate 导航）。
  scrollBehavior (to, from, savedPosition) {
    // 从 Nuxt App 中获取运行时实例。
    // 判断是否配置了自定义的滚动行为类型（默认是 auto）。
    const nuxtApp = useNuxtApp()
    // @ts-expect-error untyped, nuxt-injected option
    const behavior = useRouter().options?.scrollBehaviorType ?? 'auto'

    // By default when the returned position is falsy or an empty object, vue-router will retain the current scroll position
    // savedPosition is only available for popstate navigations (back button)
    // 默认逻辑：如果有 savedPosition，就优先返回它
    let position: ScrollPosition = savedPosition || undefined

    // 页面切换时是否需要滚动到顶部
    // 如果当前没有 savedPosition，并且路由发生了变化，默认滚动到顶部 { top: 0 }。
    // 可以通过 meta.scrollToTop = false 来禁用此行为。
    const routeAllowsScrollToTop = typeof to.meta.scrollToTop === 'function' ? to.meta.scrollToTop(to, from) : to.meta.scrollToTop

    // Scroll to top if route is changed by default
    if (!position && from && to && routeAllowsScrollToTop !== false && isChangingPage(to, from)) {
      position = { left: 0, top: 0 }
    }

    // Hash routes on the same page, no page hook is fired so resolve here
    // 如果是同一路由（to.path === from.path），根据锚点变化决定是否跳转滚动。
    // 从有 hash → 无 hash：滚动到顶部。
    // 从无 hash → 有 hash：跳转到元素位置。
    if (to.path === from.path) {
      if (from.hash && !to.hash) {
        return { left: 0, top: 0 }
      }
      if (to.hash) {
        return { el: to.hash, top: _getHashElementScrollMarginTop(to.hash), behavior }
      }
      // The route isn't changing so keep current scroll position
      return false
    }

    // Wait for `page:transition:finish` or `page:finish` depending on if transitions are enabled or not
    // 判断是否开启了页面过渡，如果是，就等待 page:transition:finish。
    // 否则只等待页面组件加载完成 page:finish。
    const hasTransition = (route: RouteLocationNormalized) => !!(route.meta.pageTransition ?? defaultPageTransition)
    const hookToWait = (hasTransition(from) && hasTransition(to)) ? 'page:transition:finish' : 'page:finish'
    return new Promise((resolve) => {
      // 使用 hookOnce 注册一次性钩子函数，确保滚动在动画或组件加载后才发生，避免跳转“抢跑”或被组件内容覆盖。
      nuxtApp.hooks.hookOnce(hookToWait, async () => {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (to.hash) {
          position = { el: to.hash, top: _getHashElementScrollMarginTop(to.hash), behavior }
        }
        resolve(position)
      })
    })
  },
}

// 查询 hash 元素，读取它的 CSS scroll-margin-top 和全局 scroll-padding-top。
// 保证滚动时元素不会被粘性头部遮挡（常见于有 fixed header 的页面）。
function _getHashElementScrollMarginTop (selector: string): number {
  try {
    const elem = document.querySelector(selector)
    if (elem) {
      return (Number.parseFloat(getComputedStyle(elem).scrollMarginTop) || 0) + (Number.parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0)
    }
  } catch {
    // ignore any errors parsing scrollMarginTop
  }
  return 0
}
