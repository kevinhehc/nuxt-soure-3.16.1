import { defineNuxtPlugin } from '../nuxt'
import { loadPayload } from '../composables/payload'
import { onNuxtReady } from '../composables/ready'
import { useRouter } from '../composables/router'
import { getAppManifest } from '../composables/manifest'

// @ts-expect-error virtual file
import { appManifest as isAppManifestEnabled, purgeCachedData } from '#build/nuxt.config.mjs'

// 主要负责在客户端加载页面 payload 数据，并将其缓存到 Nuxt 应用的静态数据存储中。
// 这样做的目的是在页面导航时动态地加载预构建好的 payload（包括 asyncData 数据、状态等），从而实现快速页面更新和更好的用户体验。

export default defineNuxtPlugin({
  name: 'nuxt:payload',
  setup (nuxtApp) {
    // TODO: Support dev
    // 跳过开发环境下的逻辑
    if (import.meta.dev) { return }

    // Load payload after middleware & once final route is resolved
    // 在路由跳转前（beforeResolve 阶段）执行逻辑，确保 middleware 执行完毕且目标路由已确定后再加载 payload 数据。

    // 用于跟踪需要从 Nuxt 静态缓存中移除的 key 集合。
    const staticKeysToRemove = new Set<string>()
    useRouter().beforeResolve(async (to, from) => {
      if (to.path === from.path) { return }
      // 去加载当前目标路径对应的 payload 数据（payload 可能包含 asyncData 产生的数据或其他预构建数据）。
      const payload = await loadPayload(to.path)
      // 如果没有获取到 payload，则直接返回，不作处理。
      if (!payload) { return }

      // 遍历 staticKeysToRemove 中记录的 key，
      // 如果启用了 purgeCachedData（配置选项，表明是否清理之前缓存的数据），删除 nuxtApp.static.data[key]。
      for (const key of staticKeysToRemove) {
        if (purgeCachedData) {
          delete nuxtApp.static.data[key]
        }
      }

      // 遍历 payload 中返回的 data 属性，将每个 key 的数据设置到 nuxtApp.static.data 中。
      // 如果遇到 payload 中有的新 key，而当前静态数据中没有，则将其添加到 staticKeysToRemove 集合中。
      // 这样一方面更新或覆盖新数据，另一方面可以跟踪哪些 key 是静态数据中曾经创建但将来可能需要清除的。
      for (const key in payload.data) {
        if (!(key in nuxtApp.static.data)) {
          staticKeysToRemove.add(key)
        }
        nuxtApp.static.data[key] = payload.data[key]
      }
    })

    onNuxtReady(() => {
      // Load payload into cache
      // 监听预加载链接事件。当 Nuxt 内部或用户触发 prefetch 逻辑时，会传入一个 URL。
      nuxtApp.hooks.hook('link:prefetch', async (url) => {
        // 获取 URL 信息，判断是否与当前主机相同（只对同域名的链接预加载）。
        const { hostname } = new URL(url, window.location.href)
        // 如果是同域链接，则调用 loadPayload(url) 进行 payload 加载，同时处理错误（使用 catch 输出警告）。
        if (hostname === window.location.hostname) {
          // TODO: use preloadPayload instead once we can support preloading islands too
          await loadPayload(url).catch(() => { console.warn('[nuxt] Error preloading payload for', url) })
        }
      })
      if (isAppManifestEnabled && navigator.connection?.effectiveType !== 'slow-2g') {
        // 如果 isAppManifestEnabled 为真，并且当前网络条件较好（连接类型不是 'slow-2g'），则在 1 秒后调用 getAppManifest。
        // 目的可能是提前加载或更新应用 manifest，用于版本管理或缓存策略更新。
        setTimeout(getAppManifest, 1000)
      }
    })
  },
})
