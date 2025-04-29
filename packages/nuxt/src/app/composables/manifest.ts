import type { MatcherExport, RouteMatcher } from 'radix3'
import { createMatcherFromExport, createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import { defu } from 'defu'
import type { H3Event } from 'h3'
import type { NitroRouteRules } from 'nitropack'
import { useNuxtApp, useRuntimeConfig } from '../nuxt'
// @ts-expect-error virtual file
import { appManifest as isAppManifestEnabled } from '#build/nuxt.config.mjs'
// @ts-expect-error virtual file
import { buildAssetsURL } from '#internal/nuxt/paths'

export interface NuxtAppManifestMeta {
  id: string
  timestamp: number
}

export interface NuxtAppManifest extends NuxtAppManifestMeta {
  matcher: MatcherExport
  prerendered: string[]
}

let manifest: Promise<NuxtAppManifest>
let matcher: RouteMatcher

// 在运行时动态加载 Nuxt App Manifest（构建生成的 meta 信息），以便做资源匹配、路由规则解析、payload 动态加载等功能。
function fetchManifest () {
  // 如果没启用 experimental.appManifest 选项，直接报错。
  // 因为整个 fetchManifest 依赖于 Nuxt 有生成 App Manifest 文件。
  if (!isAppManifestEnabled) {
    throw new Error('[nuxt] app manifest should be enabled with `experimental.appManifest`')
  }
  // 如果是在 服务器端执行（比如 SSR 渲染阶段）：
  if (import.meta.server) {
    // @ts-expect-error virtual file
    // 直接 import 本地的 #app-manifest 虚拟模块！
    // 这个模块在构建时由 Nuxt 自动生成，包含了 matcher/rules 等静态内容。
    manifest = import('#app-manifest')
  } else {
    // 如果在 客户端：
    // 需要用 $fetch 从服务器加载：
    //
    // 路径是：/_nuxt/builds/meta/{buildId}.json
    //
    // buildId 是构建时生成的唯一标识（比如 hash 字符串）。
    manifest = $fetch<NuxtAppManifest>(buildAssetsURL(`builds/meta/${useRuntimeConfig().app.buildId}.json`), {
      responseType: 'json',
    })
  }

  manifest.then((m) => {
    // 当 manifest 加载完成后（无论是 import 还是 fetch）：
    // 取出 m.matcher（包含匹配规则等信息）。
    // 调用 createMatcherFromExport(m.matcher) 创建一个实际可用的路由/规则匹配器。
    // 后续比如动态路由匹配、payload 预取，都会用到这个 matcher！
    matcher = createMatcherFromExport(m.matcher)
  }).catch((e) => {
    // 如果请求或 import 失败，
    // 友好地输出错误信息，不让整个应用崩溃。
    console.error('[nuxt] Error fetching app manifest.', e)
  })
  return manifest
}

/** @since 3.7.4 */
export function getAppManifest (): Promise<NuxtAppManifest> {
  // 如果没有开启 experimental.appManifest，直接报错。
  // 因为 App Manifest 相关功能必须显式启用。
  // 保护机制，避免调用出错。
  if (!isAppManifestEnabled) {
    throw new Error('[nuxt] app manifest should be enabled with `experimental.appManifest`')
  }
  // 如果当前是在服务器环境：
  // 标记 ssrContext._preloadManifest = true
  // 告诉 Nuxt SSR 渲染器：“这个请求需要加载 Manifest”。
  // 这样服务器渲染时可以自动注入 Manifest 相关内容，确保客户端可以无缝接收。
  if (import.meta.server) {
    useNuxtApp().ssrContext!._preloadManifest = true
  }
  return manifest || fetchManifest()
}

/** @since 3.7.4 */
export async function getRouteRules (event: H3Event): Promise<NitroRouteRules>
export async function getRouteRules (options: { path: string }): Promise<Record<string, any>>
/** @deprecated use `getRouteRules({ path })` instead */
export async function getRouteRules (url: string): Promise<Record<string, any>>
// 根据当前路径 (path)，动态获取匹配到的 Route Rules（比如中间件控制、缓存控制、CORS 控制等等）并且同时兼容 SSR 和 CSR
// 参数解析
// 路径字符串 ('/blog/123')
// H3Event（server-side 请求事件）
// { path: string } 对象
export async function getRouteRules (arg: string | H3Event | { path: string }) {
  // 如果是字符串，直接用。
  // 如果是对象或事件，从 .path 属性提取。
  const path = typeof arg === 'string' ? arg : arg.path
  if (import.meta.server) {
    // 如果是在服务端运行：
    // 标记 preload Manifest
    // 标记 ssrContext._preloadManifest = true
    // 让 SSR 阶段知道后面会需要 Manifest，提前加载好。
    useNuxtApp().ssrContext!._preloadManifest = true
    // 这里不会去 fetch manifest，而是：
    // 直接从服务器配置里的 routeRules 动态创建一个 Radix 路由树。
    // Radix Tree 是一种高效的路由匹配结构，非常适合大量规则快速匹配。
    const _routeRulesMatcher = toRouteMatcher(
      createRadixRouter({ routes: useRuntimeConfig().nitro!.routeRules }),
    )
    // matchAll(path)：找出所有匹配当前路径的规则（从子路径到父路径）。
    // .reverse()：优先让具体路径规则覆盖通用路径规则。
    // defu(...)：深度合并所有匹配到的规则对象。
    return defu({} as Record<string, any>, ..._routeRulesMatcher.matchAll(path).reverse())
  }
  // 确保客户端已经加载了 App Manifest。
  await getAppManifest()
  if (!matcher) {
    console.error('[nuxt] Error creating app manifest matcher.', matcher)
    return {}
  }
  try {
    // 客户端同样用 matcher.matchAll(path) 匹配所有规则。
    // reverse() 优先具体规则覆盖。
    // defu() 深度合并成一个最终结果。
    // 保证服务端和客户端返回一致的 route rules。
    return defu({} as Record<string, any>, ...matcher.matchAll(path).reverse())
  } catch (e) {
    console.error('[nuxt] Error matching route rules.', e)
    return {}
  }
}
