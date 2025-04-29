import { defineNuxtPlugin } from '../nuxt'
import { getAppManifest } from '../composables/manifest'
import type { NuxtAppManifestMeta } from '../composables/manifest'
import { onNuxtReady } from '../composables/ready'
// @ts-expect-error virtual file
import { buildAssetsURL } from '#internal/nuxt/paths'
// @ts-expect-error virtual file
import { outdatedBuildInterval } from '#build/nuxt.config.mjs'

// 用于检测**构建版本是否过期（outdated build）**的插件源码

export default defineNuxtPlugin((nuxtApp) => {

  // 如果当前是测试环境（如 vitest 运行时）直接跳过。
  // 避免在测试中启动轮询逻辑。
  if (import.meta.test) { return }

  // 声明一个 timeout 变量，用于管理 setTimeout 的返回值，支持清除上一次定时器。
  let timeout: NodeJS.Timeout

  // 定义一个异步函数，用于请求最新构建信息并对比当前版本。
  async function getLatestManifest () {

    // 通过 Nuxt 内部工具获取当前运行中的构建 manifest 信息。
    // 通常来自 .output/public/nuxt/manifest.json 或打包输出中的缓存信息。
    const currentManifest = await getAppManifest()

    // 先清除上次的轮询定时器（如果有）。
    // 再启动下一轮定时器，实现持续轮询。
    // outdatedBuildInterval 是预设的轮询间隔（通常是 3~30 秒）。
    if (timeout) { clearTimeout(timeout) }
    timeout = setTimeout(getLatestManifest, outdatedBuildInterval)
    try {
      // 请求 builds/latest.json，这是 Nuxt 构建系统自动生成的最新版本元信息文件。
      // 加 ?${Date.now()} 是为了强制跳过缓存（防止 CDN 返回旧内容）。
      const meta = await $fetch<NuxtAppManifestMeta>(buildAssetsURL('builds/latest.json') + `?${Date.now()}`)

      // 如果检测到 latest.json 的 id 与当前版本不同，
      // 说明页面运行的是一个“过期版本”！
      // 这时通过 Nuxt hook 触发 app:manifest:update，通知用户或插件执行更新逻辑。
      if (meta.id !== currentManifest.id) {
        // There is a newer build which we will let the user handle
        nuxtApp.hooks.callHook('app:manifest:update', meta)
      }
    } catch {
      // fail gracefully on network issue
      // 如果网络请求失败（如断网），不报错，静默跳过即可。
    }
  }

  // 在 Nuxt 应用初始化完成后，开启首次轮询任务。
  // 然后 getLatestManifest() 自己内部会递归定时调度。
  onNuxtReady(() => { timeout = setTimeout(getLatestManifest, outdatedBuildInterval) })
})
