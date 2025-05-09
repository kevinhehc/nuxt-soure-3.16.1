import { getCurrentInstance, hasInjectionContext, inject, onScopeDispose } from 'vue'
import type { Ref } from 'vue'
import type { NavigationFailure, NavigationGuard, RouteLocationNormalized, RouteLocationRaw, Router, useRoute as _useRoute, useRouter as _useRouter } from 'vue-router'
import { sanitizeStatusCode } from 'h3'
import { hasProtocol, isScriptProtocol, joinURL, parseQuery, parseURL, withQuery } from 'ufo'

import type { PageMeta } from '../../pages/runtime/composables'

import { useNuxtApp, useRuntimeConfig } from '../nuxt'
import { PageRouteSymbol } from '../components/injections'
import type { NuxtError } from './error'
import { createError, showError } from './error'

/** @since 3.0.0 */
export const useRouter: typeof _useRouter = () => {
  // 返回 $router 实例（内部自己模拟了 vue-router 的 API）
  return useNuxtApp()?.$router as Router
}

/** @since 3.0.0 */
// 返回当前 Route 对象。
// 在 middleware 中直接用 to/from 更准确。
// 基础路由对象访问。
export const useRoute: typeof _useRoute = () => {
  if (import.meta.dev && !getCurrentInstance() && isProcessingMiddleware()) {
    console.warn('[nuxt] Calling `useRoute` within middleware may lead to misleading results. Instead, use the (to, from) arguments passed to the middleware to access the new and old routes.')
  }
  if (hasInjectionContext()) {
    return inject(PageRouteSymbol, useNuxtApp()._route)
  }
  return useNuxtApp()._route
}

/** @since 3.0.0 */
// 类似 vue-router 的 onBeforeRouteLeave
// 只在目标不同的情况下触发。
export const onBeforeRouteLeave = (guard: NavigationGuard) => {
  const unsubscribe = useRouter().beforeEach((to, from, next) => {
    if (to === from) { return }
    return guard(to, from, next)
  })
  onScopeDispose(unsubscribe)
}

/** @since 3.0.0 */
// 每次导航变化就触发。
// 组件内方便处理路由变化。
export const onBeforeRouteUpdate = (guard: NavigationGuard) => {
  const unsubscribe = useRouter().beforeEach(guard)
  onScopeDispose(unsubscribe)
}

export interface RouteMiddleware {
  (to: RouteLocationNormalized, from: RouteLocationNormalized): ReturnType<NavigationGuard>
}

/** @since 3.0.0 */
/* @__NO_SIDE_EFFECTS__ */
// 定义一个中间件函数。
export function defineNuxtRouteMiddleware (middleware: RouteMiddleware) {
  return middleware
}

export interface AddRouteMiddlewareOptions {
  global?: boolean
}

interface AddRouteMiddleware {
  (name: string, middleware: RouteMiddleware, options?: AddRouteMiddlewareOptions): void
  (middleware: RouteMiddleware): void
}

/** @since 3.0.0 */
// 注册一个中间件：
// 匿名 = 全局中间件
// 有名字 = 命名中间件
// 支持全局 / 命名中间件注册
export const addRouteMiddleware: AddRouteMiddleware = (name: string | RouteMiddleware, middleware?: RouteMiddleware, options: AddRouteMiddlewareOptions = {}) => {
  const nuxtApp = useNuxtApp()
  const global = options.global || typeof name !== 'string'
  const mw = typeof name !== 'string' ? name : middleware
  if (!mw) {
    console.warn('[nuxt] No route middleware passed to `addRouteMiddleware`.', name)
    return
  }
  if (global) {
    nuxtApp._middleware.global.push(mw)
  } else {
    nuxtApp._middleware.named[name] = mw
  }
}

/** @since 3.0.0 */
const isProcessingMiddleware = () => {
  try {
    if (useNuxtApp()._processingMiddleware) {
      return true
    }
  } catch {
    return false
  }
  return false
}

// Conditional types, either one or other
type Without<T, U> = { [P in Exclude<keyof T, keyof U>]?: never }
type XOR<T, U> = (T | U) extends object ? (Without<T, U> & U) | (Without<U, T> & T) : T | U

export type OpenWindowFeatures = {
  popup?: boolean
  noopener?: boolean
  noreferrer?: boolean
} & XOR<{ width?: number }, { innerWidth?: number }>
  & XOR<{ height?: number }, { innerHeight?: number }>
  & XOR<{ left?: number }, { screenX?: number }>
  & XOR<{ top?: number }, { screenY?: number }>

export type OpenOptions = {
  target: '_blank' | '_parent' | '_self' | '_top' | (string & {})
  windowFeatures?: OpenWindowFeatures
}

export interface NavigateToOptions {
  replace?: boolean
  redirectCode?: number
  external?: boolean
  open?: OpenOptions
}

const URL_QUOTE_RE = /"/g
/** @since 3.0.0 */
// 支持普通内部跳转 (router.push/replace)
// 支持打开新窗口 (window.open)
// 支持外部链接跳转 (location.href)
// 支持服务端跳转（写入 302 Response）
// 支持 Middleware 中的特殊处理。
// 完整流程控制，非常强大！
// Nuxt 应用页面跳转统一入口！
export const navigateTo = (to: RouteLocationRaw | undefined | null, options?: NavigateToOptions): Promise<void | NavigationFailure | false> | false | void | RouteLocationRaw => {
  to ||= '/'

  const toPath = typeof to === 'string' ? to : 'path' in to ? resolveRouteObject(to) : useRouter().resolve(to).href

  // Early open handler
  if (import.meta.client && options?.open) {
    const { target = '_blank', windowFeatures = {} } = options.open

    const features = Object.entries(windowFeatures)
      .filter(([_, value]) => value !== undefined)
      .map(([feature, value]) => `${feature.toLowerCase()}=${value}`)
      .join(', ')

    open(toPath, target, features)
    return Promise.resolve()
  }

  const isExternalHost = hasProtocol(toPath, { acceptRelative: true })
  const isExternal = options?.external || isExternalHost
  if (isExternal) {
    if (!options?.external) {
      throw new Error('Navigating to an external URL is not allowed by default. Use `navigateTo(url, { external: true })`.')
    }
    const { protocol } = new URL(toPath, import.meta.client ? window.location.href : 'http://localhost')
    if (protocol && isScriptProtocol(protocol)) {
      throw new Error(`Cannot navigate to a URL with '${protocol}' protocol.`)
    }
  }

  const inMiddleware = isProcessingMiddleware()

  // Early redirect on client-side
  if (import.meta.client && !isExternal && inMiddleware) {
    if (options?.replace) {
      if (typeof to === 'string') {
        const { pathname, search, hash } = parseURL(to)
        return {
          path: pathname,
          ...(search && { query: parseQuery(search) }),
          ...(hash && { hash }),
          replace: true,
        }
      }
      return { ...to, replace: true }
    }
    return to
  }

  const router = useRouter()

  const nuxtApp = useNuxtApp()

  if (import.meta.server) {
    if (nuxtApp.ssrContext) {
      const fullPath = typeof to === 'string' || isExternal ? toPath : router.resolve(to).fullPath || '/'
      const location = isExternal ? toPath : joinURL(useRuntimeConfig().app.baseURL, fullPath)

      const redirect = async function (response: any) {
        // TODO: consider deprecating in favour of `app:rendered` and removing
        await nuxtApp.callHook('app:redirected')
        const encodedLoc = location.replace(URL_QUOTE_RE, '%22')
        const encodedHeader = encodeURL(location, isExternalHost)

        nuxtApp.ssrContext!._renderResponse = {
          statusCode: sanitizeStatusCode(options?.redirectCode || 302, 302),
          body: `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0; url=${encodedLoc}"></head></html>`,
          headers: { location: encodedHeader },
        }
        return response
      }

      // We wait to perform the redirect last in case any other middleware will intercept the redirect
      // and redirect somewhere else instead.
      if (!isExternal && inMiddleware) {
        router.afterEach(final => final.fullPath === fullPath ? redirect(false) : undefined)
        return to
      }
      return redirect(!inMiddleware ? undefined : /* abort route navigation */ false)
    }
  }

  // Client-side redirection using vue-router
  if (isExternal) {
    // Run any cleanup steps for the current scope, like ending BroadcastChannel
    nuxtApp._scope.stop()
    if (options?.replace) {
      location.replace(toPath)
    } else {
      location.href = toPath
    }
    // Within in a Nuxt route middleware handler
    if (inMiddleware) {
      // Abort navigation when app is hydrated
      if (!nuxtApp.isHydrating) {
        return false
      }
      // When app is hydrating (i.e. on page load), we don't want to abort navigation as
      // it would lead to a 404 error / page that's blinking before location changes.
      return new Promise(() => {})
    }
    return Promise.resolve()
  }

  return options?.replace ? router.replace(to) : router.push(to)
}

/**
 * This will abort navigation within a Nuxt route middleware handler.
 * @since 3.0.0
 */
// 在中间件中使用。
// 中断导航，并可以抛出一个 Error。
// 错误可以直接 showError 也可以作为 4xx/5xx 响应。
// 优雅中断导航并错误处理。
export const abortNavigation = (err?: string | Partial<NuxtError>) => {
  if (import.meta.dev && !isProcessingMiddleware()) {
    throw new Error('abortNavigation() is only usable inside a route middleware handler.')
  }

  if (!err) { return false }

  err = createError(err)

  if (err.fatal) {
    useNuxtApp().runWithContext(() => showError(err as NuxtError))
  }

  throw err
}

/** @since 3.0.0 */
// 可以动态设置本页使用的布局。
// 处理不同阶段（server/client/hydration）的特殊情况。
// 如果是在 Middleware/Server 阶段，会提前注入 meta。
// 灵活按需切换 Layout，比如博客详情页用单栏，首页用双栏。
export const setPageLayout = (layout: unknown extends PageMeta['layout'] ? string : PageMeta['layout']) => {
  const nuxtApp = useNuxtApp()
  if (import.meta.server) {
    if (import.meta.dev && getCurrentInstance() && nuxtApp.payload.state._layout !== layout) {
      console.warn('[warn] [nuxt] `setPageLayout` should not be called to change the layout on the server within a component as this will cause hydration errors.')
    }
    nuxtApp.payload.state._layout = layout
  }
  if (import.meta.dev && nuxtApp.isHydrating && nuxtApp.payload.serverRendered && nuxtApp.payload.state._layout !== layout) {
    console.warn('[warn] [nuxt] `setPageLayout` should not be called to change the layout during hydration as this will cause hydration errors.')
  }
  const inMiddleware = isProcessingMiddleware()
  if (inMiddleware || import.meta.server || nuxtApp.isHydrating) {
    const unsubscribe = useRouter().beforeResolve((to) => {
      to.meta.layout = layout as Exclude<PageMeta['layout'], Ref | false>
      unsubscribe()
    })
  }
  if (!inMiddleware) {
    useRoute().meta.layout = layout as Exclude<PageMeta['layout'], Ref | false>
  }
}

/**
 * @internal
 */
// resolveRouteObject()：拼接 path/query/hash 成完整 URL 字符串。
export function resolveRouteObject (to: Exclude<RouteLocationRaw, string>) {
  return withQuery(to.path || '', to.query || {}) + (to.hash || '')
}

/**
 * @internal
 */
// encodeURL()：正确处理外链的 URL。
export function encodeURL (location: string, isExternalHost = false) {
  const url = new URL(location, 'http://localhost')
  if (!isExternalHost) {
    return url.pathname + url.search + url.hash
  }
  if (location.startsWith('//')) {
    return url.toString().replace(url.protocol, '')
  }
  return url.toString()
}
