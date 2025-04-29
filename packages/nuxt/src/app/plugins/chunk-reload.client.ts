import { joinURL } from 'ufo'
import type { RouteLocationNormalized } from 'vue-router'
import { defineNuxtPlugin, useRuntimeConfig } from '../nuxt'
import { useRouter } from '../composables/router'
import { reloadNuxtApp } from '../composables/chunk'

// 用于在构建版本变更后或 chunk 加载失败时 自动刷新页面并恢复状态 的机制。
// 这段插件逻辑配合前面的构建版本检测 app:manifest:update 和 app:chunkError hook，是 Nuxt 为用户提供更好 PWA 静态体验的关键组件之一。

// 页面 chunk 加载失败（404）时的自动 reload
// 检测到构建版本变更后自动 reload
export default defineNuxtPlugin({
  name: 'nuxt:chunk-reload',
  setup (nuxtApp) {
    // 拿到 Nuxt 应用的 router 和运行时配置 config（用于拼 URL）。
    const router = useRouter()
    const config = useRuntimeConfig()

    // 创建一个 Set 用来记录发生过的 chunk 加载失败错误。
    const chunkErrors = new Set<Error>()

    // 每次页面跳转前，清空之前记录的错误。
    // 保证错误不会被误用在下一次导航。
    router.beforeEach(() => { chunkErrors.clear() })

    // 模块（chunk）加载失败（常见于 CDN 缓存版本差异），Nuxt 会触发 app:chunkError。
    // 把这个 error 收集起来，以便后续 router.onError 检查使用。
    nuxtApp.hook('app:chunkError', ({ error }) => { chunkErrors.add(error) })

    // 定义一个内部函数 reloadAppAtPath()，用于在错误或更新时执行页面刷新。
    function reloadAppAtPath (to: RouteLocationNormalized) {
      // 检查当前导航是否是 hash 跳转（如 #section1）。
      const isHash = 'href' in to && (to.href as string)[0] === '#'
      // 构建要跳转到的完整路径。
      // 如果是 hash 跳转，拼接 baseURL。
      // 否则使用完整路径。
      const path = isHash ? config.app.baseURL + (to as any).href : joinURL(config.app.baseURL, to.fullPath)
      // 调用 Nuxt 内部提供的 reloadNuxtApp() 函数：
      // 刷新当前页面
      // 并通过 { persistState: true } 保留状态（如 useState() 数据）。
      reloadNuxtApp({ path, persistState: true })
    }

    // 当检测到构建版本发生变化（由 app.config 插件触发的 app:manifest:update），
    // 在下一个页面导航前，调用 reloadAppAtPath() 自动刷新。
    nuxtApp.hook('app:manifest:update', () => {
      router.beforeResolve(reloadAppAtPath)
    })

    // 捕获 chunk 错误时 → 自动 reload
    router.onError((error, to) => {
      if (chunkErrors.has(error)) {
        reloadAppAtPath(to)
      }
    })
  },
})
