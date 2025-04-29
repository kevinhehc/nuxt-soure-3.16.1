// Polyfills for Safari support
// https://caniuse.com/requestidlecallback

// 定义并导出一个常量 requestIdleCallback。
//
// 类型是 Window['requestIdleCallback']（也就是标准浏览器里的 requestIdleCallback 函数类型）。
// import.meta.server 是 Nuxt 里特有的：如果当前是在 服务器端（SSR阶段），它是 true；如果在浏览器端，它是 false。

// 服务器端：返回空函数。
// 浏览器端：
// 如果浏览器原生支持：直接用。
// 如果不支持：用 setTimeout 加简单时间计算来模拟。
export const requestIdleCallback: Window['requestIdleCallback'] = import.meta.server
  // 如果是在服务器端，就用一个空函数 () => {}，并且用 as any 把类型强制转换（因为服务器端没有浏览器API，避免报错）。
  // 也就是说，服务器端没有 requestIdleCallback，但代码运行不能中断，所以用一个空函数占位。
  ? (() => {}) as any
  // 如果是在浏览器端：
  // 首先检查 globalThis.requestIdleCallback 是否存在。
  // 如果浏览器支持（比如 Chrome 支持），就直接用原生的。
  // 如果浏览器不支持（比如一些旧版浏览器），就自己造一个polyfill（兼容代码）。
  : (globalThis.requestIdleCallback || ((cb) => {
    // 记录当前时间，后面要计算“还有多少空闲时间”。
      const start = Date.now()
    // 创建一个模拟的 IdleDeadline 对象。
    // didTimeout: false：永远不会超时（真实的 requestIdleCallback 也允许这样）。
    // timeRemaining()：返回“离50毫秒结束还剩多少时间”，如果过了50ms，就返回0。
      const idleDeadline = {
        didTimeout: false,
        timeRemaining: () => Math.max(0, 50 - (Date.now() - start)),
      }
      // 用 setTimeout 模拟调度，延迟1毫秒调用 cb（回调函数），并传入我们造出来的 idleDeadline。
      return setTimeout(() => { cb(idleDeadline) }, 1)
    }))

export const cancelIdleCallback: Window['cancelIdleCallback'] = import.meta.server
  // 如果是服务器端，跟前面一样，给个空函数占位。
  ? (() => {}) as any
  // 如果是浏览器端：
  // 优先用浏览器原生的 cancelIdleCallback（如果有的话）。
  // 如果没有原生支持，就用 clearTimeout 来取消（因为我们上面 requestIdleCallback 是 setTimeout 造的，所以取消时也要用 clearTimeout）。
  : (globalThis.cancelIdleCallback || ((id) => { clearTimeout(id) }))
