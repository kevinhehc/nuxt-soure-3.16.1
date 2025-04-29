// isChangingPage：判断 to 和 from 是否真正是切换了页面。
// useRouter：拿到 Nuxt 中用的 vue-router 实例。
// defineNuxtPlugin：定义一个 Nuxt 插件。
// defaultViewTransition：从编译时的 nuxt.config 里拿默认的 viewTransition 配置。
import { isChangingPage } from '../components/utils'
import { useRouter } from '../composables/router'
import { defineNuxtPlugin } from '../nuxt'
// @ts-expect-error virtual file
import { appViewTransition as defaultViewTransition } from '#build/nuxt.config.mjs'

// 在支持 document.startViewTransition 的浏览器中自动管理页面切换的过渡动画 (比如 Chrome、Edge 已经支持）

export default defineNuxtPlugin((nuxtApp) => {
  // 如果浏览器不支持 document.startViewTransition()（比如 Safari），
  // 直接 return，不加载这个插件逻辑。
  if (!document.startViewTransition) {
    return
  }

  // finishTransition：正常结束动画的回调。
  // abortTransition：取消动画的回调。
  let finishTransition: undefined | (() => void)
  let abortTransition: undefined | (() => void)

  const router = useRouter()

  // 在路由切换过程中，进入目标路由之前调用。
  // 这是添加 view-transition 动画的最佳时机。
  router.beforeResolve(async (to, from) => {

    // 计算是否需要执行过渡动画
    const viewTransitionMode = to.meta.viewTransition ?? defaultViewTransition
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const prefersNoTransition = prefersReducedMotion && viewTransitionMode !== 'always'

    if (viewTransitionMode === false || prefersNoTransition || !isChangingPage(to, from)) {
      // 优先取 to.meta.viewTransition，否则用 defaultViewTransition。
      // 检查用户是否开启了减少动画 (prefers-reduced-motion)。
      // 如果：
      //    用户禁用了过渡
      //    配置了不使用 viewTransition
      //    其实页面没变
      // 就直接 return，不执行动画。
      return
    }

    const promise = new Promise<void>((resolve, reject) => {
      // 创建一个 Promise。
      // 用 resolve() 在页面切换完成时完成动画。
      // 用 reject() 在出现错误时取消动画。
      finishTransition = resolve
      abortTransition = reject
    })

    // 提前声明 changeRoute 函数。
    // ready Promise 会在真正开始切换路由时被 resolve。
    let changeRoute: () => void
    const ready = new Promise<void>(resolve => (changeRoute = resolve))

    // 调用浏览器原生的 startViewTransition。
    // 核心逻辑：
    // 先 changeRoute()（开始真正的页面切换）
    // 再等 promise 完成（动画结束）。
    const transition = document.startViewTransition!(() => {
      changeRoute()
      return promise
    })

    // 无论成功/失败，一旦 View Transition 结束，
    // 清理掉 abortTransition 和 finishTransition。
    transition.finished.then(() => {
      abortTransition = undefined
      finishTransition = undefined
    })

    // 触发 Nuxt 钩子 page:view-transition:start
    // 允许其他插件监听这个事件，比如记录统计、加载动画控制等。
    await nuxtApp.callHook('page:view-transition:start', transition)

    // 在 router.beforeResolve 中返回 ready，
    // 控制路由切换必须等待 view-transition 启动完。
    return ready
  })

  // 如果 Vue 组件中出现错误（比如 setup 里 Promise reject），
  // 主动取消正在进行的 View Transition。
  nuxtApp.hook('vue:error', () => {
    abortTransition?.()
    abortTransition = undefined
  })

  // 页面切换结束时，主动完成 View Transition 动画。
  nuxtApp.hook('page:finish', () => {
    finishTransition?.()
    finishTransition = undefined
  })
})
