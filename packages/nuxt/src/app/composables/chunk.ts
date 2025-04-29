import destr from 'destr'
import { useNuxtApp } from '../nuxt'

// reloadNuxtApp 可以接受的配置参数。
export interface ReloadNuxtAppOptions {
  /**
   * Number of milliseconds in which to ignore future reload requests
   * @default {10000}
   */
  // TTL（Time To Live）毫秒数。
  // 在这段时间内，如果已经 reload 过，就忽略后续的 reload 请求。
  // 默认值是 10000ms（10秒）。
  // 防止短时间内多次 reload，造成卡顿或者奇怪的问题。
  ttl?: number
  /**
   * Force a reload even if one has occurred within the previously specified TTL.
   * @default {false}
   */
  // 是否强制 reload，即使 TTL 内已经 reload 过。
  // 默认是 false。
  // **用途：**有时候你明知道想立即 reload，比如重大配置变更。
  force?: boolean
  /**
   * Whether to dump the current Nuxt state to sessionStorage (as `nuxt:reload:state`).
   * @default {false}
   */
  // 是否把当前 Nuxt 应用的 state（比如 Vuex/pinia/store）保存到 sessionStorage。
  // 保存成 nuxt:reload:state。
  // 这样 reload 之后，可以在客户端恢复状态，减少闪屏/跳动。
  // 默认 false。
  persistState?: boolean
  /**
   * The path to reload. If this is different from the current window location it will
   * trigger a navigation and add an entry in the browser history.
   * @default {window.location.pathname}
   */
  // 重新加载的 URL 路径。
  // 如果设置了不同路径，会触发浏览器跳转（pushState），否则只是刷新当前页面
  // 默认值是当前的 window.location.pathname。
  path?: string
}

/** @since 3.3.0 */
export function reloadNuxtApp (options: ReloadNuxtAppOptions = {}) {
  // 如果当前是在服务器端（Node 环境），直接退出
  // 因为只有浏览器（客户端）才能 reload 页面。
  if (import.meta.server) { return }

  // 决定要 reload 的目标 URL。
  // 如果用户没传 path，就用当前页面地址。
  const path = options.path || window.location.pathname

  // 尝试读取 sessionStorage 里保存的 nuxt:reload 信息。
  // 用 destr()（Nuxt 常用安全 JSON 解析函数）解析，防止解析失败。
  // handledPath 会包含：
  // 上次 reload 的 path
  // 上次 reload 的过期时间戳
  let handledPath: Record<string, any> = {}
  try {
    handledPath = destr(sessionStorage.getItem('nuxt:reload') || '{}')
  } catch {
    // fail gracefully if we can't access sessionStorage
  }

  // 满足以下任一条件就可以重新 reload：
  // options.force = true （强制 reload）
  // 这次 reload 的 path 和上次不一样
  // 上次 reload 的 ttl 已经过期（expires < 当前时间）
  if (options.force || handledPath?.path !== path || handledPath?.expires < Date.now()) {
    try {
      sessionStorage.setItem('nuxt:reload', JSON.stringify({ path, expires: Date.now() + (options.ttl ?? 10000) }))
    } catch {
      // fail gracefully if we can't access sessionStorage
    }

    // 成功 reload 之后，写一份新的 nuxt:reload 记录到 sessionStorage。
    // 用来未来防止短时间重复 reload。
    if (options.persistState) {
      // 如果启用 persistState，保存 Nuxt 的应用状态
      try {
        // TODO: handle serializing/deserializing complex states as JSON: https://github.com/nuxt/nuxt/pull/19205
        sessionStorage.setItem('nuxt:reload:state', JSON.stringify({ state: useNuxtApp().payload.state }))
      } catch {
        // fail gracefully if we can't access sessionStorage
      }
    }

    // 如果当前页面路径和目标 path 不一样：
    // 跳转到目标 path。
    // 否则：
    // 刷新当前页面。
    if (window.location.pathname !== path) {
      window.location.href = path
    } else {
      window.location.reload()
    }
  }
}
