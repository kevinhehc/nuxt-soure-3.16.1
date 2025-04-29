// @ts-expect-error withAsyncContext is internal API
import { getCurrentInstance, withAsyncContext as withVueAsyncContext } from 'vue'

/** @since 3.8.0 */
// 定义并导出一个函数 withAsyncContext。
// 它接受一个参数 fn，要求是一个返回 Promise 的函数（也就是异步函数）
//  这个 fn 是你想在某种「上下文」中执行的异步逻辑。
//
// withVueAsyncContext 是 Vue 3 的内部工具（在 Nuxt 中也有自己的封装）。
// 它的作用是：在执行一个异步函数时，保留当前组件实例的上下文（Context），比如 provide/inject、currentInstance 等。
// 因为一般异步代码会丢失 Vue 的上下文，所以这里用 withVueAsyncContext 包起来，确保在 await 之后还能正确拿到依赖。
// 开始包装一个新的函数传进去。
export function withAsyncContext (fn: () => PromiseLike<unknown>) {
  return withVueAsyncContext(() => {
    // 调用 getCurrentInstance() 拿到当前组件实例。
    // 通过实例的 appContext.app.$nuxt 获取到 Nuxt 专用的 nuxtApp 对象。
    // nuxtApp 是 Nuxt 特别封装的一个对象，里面挂了很多运行时的工具，比如：
    // $fetch
    // ssrContext
    // runWithContext
    // 还有插件注册进来的属性等等。
    const nuxtApp = getCurrentInstance()?.appContext.app.$nuxt
    // 判断 nuxtApp 是否存在：
    // 如果存在，就用 nuxtApp.runWithContext(fn) 来执行 fn。
    // runWithContext 会在 Nuxt 的请求上下文中执行异步函数，确保比如 $fetch、useState 这些能正确关联到当前请求。
    // 如果 nuxtApp 不存在（极少数场景，比如还没初始化完），就直接裸执行 fn()。
    return nuxtApp ? nuxtApp.runWithContext(fn) : fn()
  })
}
