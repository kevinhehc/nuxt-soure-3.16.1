import type { H3Event } from 'h3'
import { setResponseStatus as _setResponseStatus, appendHeader, getRequestHeader, getRequestHeaders, getResponseHeader, removeResponseHeader, setResponseHeader } from 'h3'
import { computed, getCurrentInstance, ref } from 'vue'
import type { H3Event$Fetch } from 'nitropack'

import type { NuxtApp } from '../nuxt'
import { useNuxtApp } from '../nuxt'
import { toArray } from '../utils'
import { useServerHead } from './head'

/** @since 3.0.0 */
export function useRequestEvent (nuxtApp: NuxtApp = useNuxtApp()) {
  return nuxtApp.ssrContext?.event
}

/** @since 3.0.0 */
export function useRequestHeaders<K extends string = string> (include: K[]): { [key in Lowercase<K>]?: string }
export function useRequestHeaders (): Readonly<Record<string, string>>

// 在服务器端，安全地提取 HTTP 请求头（headers）；在客户端直接返回空对象。
export function useRequestHeaders (include?: any[]) {
  // 如果运行在浏览器端（客户端）：
  // 直接返回一个空对象 {}。
  // 因为浏览器端是拿不到服务器请求 headers 的。
  // 避免出错，同时防止客户端暴露服务器数据。
  if (import.meta.client) { return {} }

  // 调用 useRequestEvent() 拿到当前请求的 H3Event 对象。
  // 这是 Nuxt 服务器端处理请求的上下文。
  const event = useRequestEvent()
  // 如果拿到了 event，就用 getRequestHeaders(event) 提取所有请求头。
  // 如果 event 不存在（极少数情况），fallback 返回空对象。
  const _headers = event ? getRequestHeaders(event) : {}
  // 如果调用时没有传入 include 参数，或者 event 不存在，
  // 直接返回 _headers，也就是全部请求头。
  // 兼容两种用法：拿全部 or 拿指定字段。
  if (!include || !event) { return _headers }

  // 创建一个干净的空对象 headers。
  // 遍历 include 列表：
  // 每个 key 都小写化（HTTP headers 不区分大小写，但通常转小写标准化）。
  // 只从 _headers 中提取指定字段，放到 headers 里。
  // 最后返回筛选后的 headers。
  // 让你只拿需要的 headers，比如只要 "authorization" 或 "cookie"。
  const headers = Object.create(null)
  for (const _key of include) {
    const key = _key.toLowerCase()
    const header = _headers[key]
    if (header) {
      headers[key] = header
    }
  }
  return headers
}

/** @since 3.9.0 */
export function useRequestHeader (header: string) {
  if (import.meta.client) { return undefined }
  const event = useRequestEvent()
  return event ? getRequestHeader(event, header) : undefined
}

/** @since 3.2.0 */
// 在服务器端拿到带有当前请求上下文 (Request Context) 的 $fetch 函数；在客户端直接返回全局 $fetch。
// SSR 期间安全地发内部 API 请求，比如带请求头、cookies、用户认证等。
export function useRequestFetch (): H3Event$Fetch | typeof global.$fetch {
  // 如果在 客户端运行（浏览器端）：
  // 直接返回全局的 $fetch。
  // 因为浏览器端请求 API 只需要普通的 fetch，不需要绑定任何服务器上下文。
  if (import.meta.client) {
    return globalThis.$fetch
  }

  // 如果在 服务器端运行：
  // 调用 useRequestEvent() 拿到当前请求的 H3Event（请求上下文对象）。
  // 如果 event 存在且有 $fetch 方法，就返回 event.$fetch。
  // 这是一个绑定了当前请求上下文的 $fetch！
  // 会自动携带 cookies、headers 等信息。
  // 否则 fallback 返回全局 $fetch。
  // 保证服务器端发 API 请求时，能带上正确的用户状态信息（比如 SSR 时用户登录态）。
  return useRequestEvent()?.$fetch || globalThis.$fetch
}

/** @since 3.0.0 */
export function setResponseStatus (event: H3Event, code?: number, message?: string): void
/** @deprecated Pass `event` as first option. */
export function setResponseStatus (code: number, message?: string): void
// 在服务器端安全地设置当前请求的 HTTP 响应状态码（比如设置 404、500、302 等）。
// 调用 setResponseStatus(arg1, arg2, arg3)
//     ↓
// 如果在客户端
//     → 什么都不做
//     ↓
// 如果 arg1 是 H3Event
//     → 直接设置这个事件的响应状态
//     ↓
// 如果 arg1 是 number 或 undefined
//     ↓
// 拿到当前请求事件
//     → 设置这个事件的响应状态
export function setResponseStatus (arg1: H3Event | number | undefined, arg2?: number | string, arg3?: string) {
  // 如果是浏览器端运行：
  // 什么都不做，直接返回。
  // 因为浏览器端控制不了服务器的 HTTP 状态。
  // 保证只在服务器端起效。
  if (import.meta.client) { return }
  if (arg1 && typeof arg1 !== 'number') {
    return _setResponseStatus(arg1, arg2 as number | undefined, arg3)
  }
  const event = useRequestEvent()
  if (event) {
    return _setResponseStatus(event, arg1, arg2 as string | undefined)
  }
}

/** @since 3.14.0 */
// 在服务器端可以动态读取/设置当前请求的 HTTP 响应头，客户端返回空值或警告。
// 而且还封装成了 computed()，支持响应式双向绑定！
// 输入参数 header 是一个字符串，比如 'Content-Type'、'Set-Cookie'、'X-Custom-Header'。
// 返回一个 响应式 computed 对象，可以 get 也可以 set。
export function useResponseHeader (header: string) {
  if (import.meta.client) {
    // 如果是在 浏览器端运行：
    // 因为浏览器没办法修改服务器的 HTTP 响应头，所以要特殊处理。
    if (import.meta.dev) {
      return computed({
        // get() 返回 undefined
        // set() 会输出一条友好警告："Setting response headers is not supported in the browser."
        get: () => undefined,
        set: () => console.warn('[nuxt] Setting response headers is not supported in the browser.'),
      })
    }
    // 在生产环境，直接返回一个空的 ref(undefined)。
    // 避免输出警告污染控制台，同时保证类型兼容。
    return ref()
  }

  // 调用 useRequestEvent()，拿到当前请求对应的 H3Event 对象。
  // 这是服务器端处理 HTTP 请求的上下文。
  // 服务器端可以直接操作 event 的 response headers！
  const event = useRequestEvent()!

  return computed({
    get () {
      // 通过 getResponseHeader(event, header) 读取当前响应头的值。
      return getResponseHeader(event, header)
    },
    set (newValue) {
      // 如果传入的新值为空，调用 removeResponseHeader(event, header) 删除这个响应头。
      if (!newValue) {
        return removeResponseHeader(event, header)
      }
      // 如果有新值，调用 setResponseHeader(event, header, newValue) 设置新的响应头。
      return setResponseHeader(event, header, newValue)
    },
  })
}

/** @since 3.8.0 */
// 在服务器端 prerender 模式下，告诉 Nitro 在当前请求期间要额外预渲染一组路由路径。
// 可以理解为：
// 动态声明 —— 让 Nitro 生成除了当前请求页面之外的其他静态页面！
export function prerenderRoutes (path: string | string[]) {
  // 如果当前不是在服务器端 (import.meta.server)，或者没有开启预渲染模式 (import.meta.prerender)：
  // 直接返回，什么也不做。
  // 防止在客户端或非预渲染模式下出错。
  if (!import.meta.server || !import.meta.prerender) { return }

  // 输入参数可以是：
  // 单个路径字符串，例如 '/blog'
  // 或者路径数组，例如 ['/blog', '/about', '/contact']
  const paths = toArray(path)

  // 调用 useRequestEvent() 拿到当前服务器请求的 H3Event。
  // 调用 appendHeader() 在 response header 上追加一行：
  // x-nitro-prerender: 路径1,路径2,路径3
  // 每个路径都用 encodeURIComponent() 编码，防止路径中有特殊字符出错。
  // 用英文逗号 , 分隔多个路径。
  // 这样 Nitro 在处理响应时，就知道需要额外预渲染哪些页面了！
  appendHeader(useRequestEvent()!, 'x-nitro-prerender', paths.map(p => encodeURIComponent(p)).join(', '))
}

// 预定义一个特殊的 HTML 属性：data-prehydrate-id
// 未来在组件 DOM 上打标识用，方便定位哪些元素需要预处理。
const PREHYDRATE_ATTR_KEY = 'data-prehydrate-id'

/**
 * `onPrehydrate` is a composable lifecycle hook that allows you to run a callback on the client immediately before
 * Nuxt hydrates the page. This is an advanced feature.
 *
 * The callback will be stringified and inlined in the HTML so it should not have any external
 * dependencies (such as auto-imports) or refer to variables defined outside the callback.
 *
 * The callback will run before Nuxt runtime initializes so it should not rely on the Nuxt or Vue context.
 * @since 3.12.0
 */
export function onPrehydrate (callback: (el: HTMLElement) => void): void
// 在客户端页面"水合"（hydrate）之前，运行一段小型脚本，提前操作 DOM。
// 这段脚本会被内联进 HTML 里，在 Nuxt/Vue 还没启动之前执行！
export function onPrehydrate (callback: string | ((el: HTMLElement) => void), key?: string): undefined | string {
  // 只允许在 服务器端调用。
  // 因为它的目的是生成服务器渲染时内联的脚本。
  // 保证逻辑正确性。
  if (import.meta.client) { return }

  // 如果 callback 还不是字符串（而是函数）：
  // 抛出错误！
  //
  // 正常流程中，Nuxt 构建器会把函数转成字符串。
  // 如果报错了，说明：
  // 可能是某个库忘了加到 build.transpile。
  // 提醒开发者正确使用，避免构建漏掉。
  if (typeof callback !== 'string') {
    throw new TypeError('[nuxt] To transform a callback into a string, `onPrehydrate` must be processed by the Nuxt build pipeline. If it is called in a third-party library, make sure to add the library to `build.transpile`.')
  }

  // 拿到当前 Vue 组件实例
  // 拿到当前组件实例（如果有的话）。
  // 后续可以在实例的 attrs 上打上预处理标记。
  // 支持组件粒度地标记需要预处理的元素。
  const vm = getCurrentInstance()
  // 把 data-prehydrate-id=":key1::key2:" 这样添加到组件的 HTML attributes 里。
  // 用 : 包裹 key，防止冲突。
  // 支持一个元素打多个 key。
  // 让生成的 HTML 中标记哪些 DOM 节点需要被特定的预处理代码操作。
  if (vm && key) {
    vm.attrs[PREHYDRATE_ATTR_KEY] ||= ''
    key = ':' + key + ':'
    if (!(vm.attrs[PREHYDRATE_ATTR_KEY] as string).includes(key)) {
      vm.attrs[PREHYDRATE_ATTR_KEY] += key
    }
  }

  // 如果有 key（有打标记）：
  // 脚本变成：
  // document.querySelectorAll('[data-prehydrate-id*=":key:"]').forEach(...)
  // 只作用到特定元素上。
  // 如果没有 key：
  // 脚本直接执行 callback。
  // 让页面级预处理或者元素级预处理都支持。
  const code = vm && key
    ? `document.querySelectorAll('[${PREHYDRATE_ATTR_KEY}*=${JSON.stringify(key)}]').forEach` + callback
    : (callback + '()')

  // 把脚本插到 <body> 关闭标签前
  // 使用 useServerHead() 动态注册一个 <script> 标签。
  // 配置：
  // tagPosition: 'bodyClose'：插入到 <body> 结束前。
  // tagPriority: 'critical'：高优先级，确保早执行。
  // innerHTML: code：内联脚本内容。
  // 保证这个脚本能在 Nuxt/Vue Hydration 之前运行！
  useServerHead({
    script: [{
      key: vm && key ? key : undefined,
      tagPosition: 'bodyClose',
      tagPriority: 'critical',
      innerHTML: code,
    }],
  })

  // 如果是组件里调用且有 key，返回当前元素上的 data-prehydrate-id。
  // 否则返回 undefined。
  // 主要是为了在内部链式处理时有需要时继续使用。
  return vm && key ? vm.attrs[PREHYDRATE_ATTR_KEY] as string : undefined
}
