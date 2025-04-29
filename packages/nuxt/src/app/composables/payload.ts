import { hasProtocol, joinURL, withoutTrailingSlash } from 'ufo'
import { parse } from 'devalue'
import { getCurrentInstance, onServerPrefetch, reactive } from 'vue'
import { useNuxtApp, useRuntimeConfig } from '../nuxt'
import type { NuxtPayload } from '../nuxt'
import { useHead } from './head'

import { useRoute } from './router'
import { getAppManifest, getRouteRules } from './manifest'

// @ts-expect-error virtual import
import { appId, appManifest, multiApp, payloadExtraction, renderJsonPayloads } from '#build/nuxt.config.mjs'

interface LoadPayloadOptions {
  fresh?: boolean
  hash?: string
}

/** @since 3.0.0 */
// 从服务器静态目录中，加载某个路径的页面的预渲染 payload 数据。
// 服务器端跳过（import.meta.server）
// 必须开启了 payloadExtraction 配置（否则没 payload 文件）
// 调用 isPrerendered(url) 检查这个 URL 是否是预渲染页面
// 生成 payload 文件 URL（调用 _getPayloadURL）
// 加载 payload 文件内容（调用 _importPayload）
// 返回解析后的对象
export async function loadPayload (url: string, opts: LoadPayloadOptions = {}): Promise<Record<string, any> | null> {
  if (import.meta.server || !payloadExtraction) { return null }
  // TODO: allow payload extraction for non-prerendered URLs
  const shouldLoadPayload = await isPrerendered(url)
  if (!shouldLoadPayload) {
    return null
  }
  const payloadURL = await _getPayloadURL(url, opts)
  return await _importPayload(payloadURL) || null
}
let linkRelType: string | undefined
function detectLinkRelType () {
  if (import.meta.server) { return 'preload' }
  if (linkRelType) { return linkRelType }
  const relList = document.createElement('link').relList
  linkRelType = relList && relList.supports && relList.supports('prefetch') ? 'prefetch' : 'preload'
  return linkRelType
}
/** @since 3.0.0 */
// 提前在后台预加载某个 URL 的 payload 文件，加快跳转时速度！
// 获取 payload 文件 URL
// 根据是否是 JSON payload，生成 <link rel="prefetch/preload"> 标签
// 插入到 HTML <head> 中，浏览器后台加载
// 加载成功或失败监听 resolve/reject
// 服务端渲染期间，挂到 onServerPrefetch 保证并行执行
// 预取 payload，不占主线程，不打断渲染流！
export function preloadPayload (url: string, opts: LoadPayloadOptions = {}): Promise<void> {
  const nuxtApp = useNuxtApp()
  const promise = _getPayloadURL(url, opts).then((payloadURL) => {
    const link = renderJsonPayloads
      ? { rel: detectLinkRelType(), as: 'fetch', crossorigin: 'anonymous', href: payloadURL } as const
      : { rel: 'modulepreload', crossorigin: '', href: payloadURL } as const

    if (import.meta.server) {
      nuxtApp.runWithContext(() => useHead({ link: [link] }))
    } else {
      const linkEl = document.createElement('link')
      for (const key of Object.keys(link) as Array<keyof typeof link>) {
        linkEl[key === 'crossorigin' ? 'crossOrigin' : key] = link[key]!
      }
      document.head.appendChild(linkEl)
      return new Promise<void>((resolve, reject) => {
        linkEl.addEventListener('load', () => resolve())
        linkEl.addEventListener('error', () => reject())
      })
    }
  })
  if (import.meta.server) {
    onServerPrefetch(() => promise)
  }
  return promise
}

// --- Internal ---

const filename = renderJsonPayloads ? '_payload.json' : '_payload.js'
// 生成 payload 文件的真实访问 URL。
// 保证是相对路径，不允许绝对域名
// 根据 fresh 选项或者 buildId 决定 query 参数（用于防止缓存）
// 根据是否有 CDN 配置，返回正确 base URL
// 动态构建带防缓存 query 的 payload 链接！
async function _getPayloadURL (url: string, opts: LoadPayloadOptions = {}) {
  const u = new URL(url, 'http://localhost')
  if (u.host !== 'localhost' || hasProtocol(u.pathname, { acceptRelative: true })) {
    throw new Error('Payload URL must not include hostname: ' + url)
  }
  const config = useRuntimeConfig()
  const hash = opts.hash || (opts.fresh ? Date.now() : config.app.buildId)
  const cdnURL = config.app.cdnURL
  const baseOrCdnURL = cdnURL && await isPrerendered(url) ? cdnURL : config.app.baseURL
  return joinURL(baseOrCdnURL, u.pathname, filename + (hash ? `?${hash}` : ''))
}

// 从 URL 加载并解析 payload 文件内容。
// 如果是 renderJsonPayloads，用 fetch 直接拉 JSON 文本
// 如果是传统模式（JS），用 import() 动态加载模块
// catch 错误防止崩溃
// 兼容 .json 和 .js 两种 payload 文件格式！
async function _importPayload (payloadURL: string) {
  if (import.meta.server || !payloadExtraction) { return null }
  const payloadPromise = renderJsonPayloads
    ? fetch(payloadURL, { cache: 'force-cache' }).then(res => res.text().then(parsePayload))
    : import(/* webpackIgnore: true */ /* @vite-ignore */ payloadURL).then(r => r.default || r)

  try {
    return await payloadPromise
  } catch (err) {
    console.warn('[nuxt] Cannot load payload ', payloadURL, err)
  }
  return null
}
/** @since 3.0.0 */
// 检查某个 URL 是否是 Nuxt 的预渲染（SSG）页面。
// 如果有 appManifest，直接查 manifest.prerendered.includes(url)
// 否则 fallback：动态检查 RouteRules 是否有 prerender: true
// 服务器端可以靠 x-nitro-prerender header 判断（未实现 TODO）
// 只对预渲染出来的页面进行 payload 加载或预取！
export async function isPrerendered (url = useRoute().path) {
  const nuxtApp = useNuxtApp()
  // Note: Alternative for server is checking x-nitro-prerender header
  if (!appManifest) { return !!nuxtApp.payload.prerenderedAt }
  url = withoutTrailingSlash(url)
  // manifest
  const manifest = await getAppManifest()
  if (manifest.prerendered.includes(url)) {
    return true
  }
  return nuxtApp.runWithContext(async () => {
    const rules = await getRouteRules({ path: url })
    return !!rules.prerender && !rules.redirect
  })
}

let payloadCache: NuxtPayload | null = null

/** @since 3.4.0 */
// 在客户端初始化时，拿到嵌入在 HTML 里的 Nuxt SSR 渲染数据（__NUXT__）。
// 找到页面里的 <script id="__NUXT_DATA__">
// 解析内联 JSON 数据
// 如果有 data-src 属性，再加载外部 payload
// 最后合并：内联数据 + 外链数据 + window.__NUXT__ 里数据
// 将 public config 转成 reactive
// 客户端 hydration 阶段的数据来源！
export async function getNuxtClientPayload () {
  if (import.meta.server) {
    return null
  }
  if (payloadCache) {
    return payloadCache
  }

  const el = multiApp ? document.querySelector(`[data-nuxt-data="${appId}"]`) as HTMLElement : document.getElementById('__NUXT_DATA__')
  if (!el) {
    return {} as Partial<NuxtPayload>
  }

  const inlineData = await parsePayload(el.textContent || '')

  const externalData = el.dataset.src ? await _importPayload(el.dataset.src) : undefined

  payloadCache = {
    ...inlineData,
    ...externalData,
    ...(multiApp ? window.__NUXT__?.[appId] : window.__NUXT__),
  }

  if (payloadCache!.config?.public) {
    payloadCache!.config.public = reactive(payloadCache!.config.public)
  }

  return payloadCache
}

// 将字符串形式的 payload 按照配置的 revivers 正确反序列化。
// 调用 parse(payload, revivers)
// Revivers 是自定义的特殊类型（比如 NuxtError, Ref, Reactive）
// 让复杂数据结构可以在 Server ➔ Client 之间正确还原！
export async function parsePayload (payload: string) {
  return await parse(payload, useNuxtApp()._payloadRevivers)
}

/**
 * This is an experimental function for configuring passing rich data from server -> client.
 * @since 3.4.0
 */
// 允许开发者自定义数据序列化
// Reducer：Server side，在输出 payload 时压缩/简化对象
export function definePayloadReducer (
  name: string,
  reduce: (data: any) => any,
) {
  if (import.meta.server) {
    useNuxtApp().ssrContext!._payloadReducers[name] = reduce
  }
}

/**
 * This is an experimental function for configuring passing rich data from server -> client.
 *
 * This function _must_ be called in a Nuxt plugin that is `unshift`ed to the beginning of the Nuxt plugins array.
 * @since 3.4.0
 */
// 允许开发者自定义数据反序列化
// Reviver：Client side，在解析 payload 时还原对象
export function definePayloadReviver (
  name: string,
  revive: (data: any) => any | undefined,
) {
  if (import.meta.dev && getCurrentInstance()) {
    console.warn('[nuxt] [definePayloadReviver] This function must be called in a Nuxt plugin that is `unshift`ed to the beginning of the Nuxt plugins array.')
  }
  if (import.meta.client) {
    useNuxtApp()._payloadRevivers[name] = revive
  }
}
