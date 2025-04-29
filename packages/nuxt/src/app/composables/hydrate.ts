import { useNuxtApp } from '../nuxt'
import type { NuxtPayload } from '../nuxt'

/**
 * Allows full control of the hydration cycle to set and receive data from the server.
 * @param key a unique key to identify the data in the Nuxt payload
 * @param get a function that returns the value to set the initial data
 * @param set a function that will receive the data on the client-side
 * @since 3.0.0
 */
// 在服务端渲染 (SSR) 时把特定数据写入 Nuxt payload，客户端启动时再从 payload 里恢复回来
// SSR 时 ➔ 存
// CSR 时 ➔ 取
export const useHydration = <K extends keyof NuxtPayload, T = NuxtPayload[K]> (key: K, get: () => T, set: (value: T) => void) => {
  // 调用 useNuxtApp() 获取当前运行时的 NuxtApp 实例。
  const nuxtApp = useNuxtApp()

  // 只有在服务端运行时执行。
  // 注册 app:rendered 钩子（页面渲染完成后触发）。
  if (import.meta.server) {
    nuxtApp.hooks.hook('app:rendered', () => {
      // 调用传入的 get() 方法，取出当前要保存的数据。
      // 把结果写入到 nuxtApp.payload[key] 里面。
      nuxtApp.payload[key] = get()
    })
  }

  // 只有在客户端运行时执行。
  // 注册 app:created 钩子（Nuxt 应用创建时触发）。
  if (import.meta.client) {
    // 从 nuxtApp.payload[key] 中读取服务端注入的数据。
    // 调用传入的 set() 方法，把数据恢复到当前客户端环境中。
    // 这样客户端就能无缝接收到服务器预注入的初始数据。
    nuxtApp.hooks.hook('app:created', () => {
      set(nuxtApp.payload[key] as T)
    })
  }
}
