import { isReadonly, reactive, shallowReactive, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { RouteLocation, RouteLocationNormalizedLoaded, Router, RouterScrollBehavior } from 'vue-router'
import { START_LOCATION, createMemoryHistory, createRouter, createWebHashHistory, createWebHistory } from 'vue-router'
import { createError } from 'h3'
import { isEqual, withoutBase } from 'ufo'

import type { Plugin, RouteMiddleware } from 'nuxt/app'
import type { PageMeta } from '../composables'

import { toArray } from '../utils'

import { getRouteRules } from '#app/composables/manifest'
import { defineNuxtPlugin, useRuntimeConfig } from '#app/nuxt'
import { clearError, showError, useError } from '#app/composables/error'
import { navigateTo } from '#app/composables/router'

// @ts-expect-error virtual file
import { appManifest as isAppManifestEnabled } from '#build/nuxt.config.mjs'
import _routes, { handleHotUpdate } from '#build/routes'
import routerOptions, { hashMode } from '#build/router.options'
// @ts-expect-error virtual file
import { globalMiddleware, namedMiddleware } from '#build/middleware'

// 负责初始化并配置 Vue Router 的整个生命周期。这是 Nuxt 页面导航和路由中间件工作的根基。
// 初始化 vue-router 实例
// 提供服务端（SSR）与客户端（SPA）统一的路由行为
// 执行页面跳转前后的生命周期钩子
// 管理页面中间件（middleware）、layout、错误等

// https://github.com/vuejs/router/blob/4a0cc8b9c1e642cdf47cc007fa5bbebde70afc66/packages/router/src/history/html5.ts#L37
// 在客户端读取浏览器地址栏，计算出当前路由的“逻辑路径”，考虑 base、hash 模式、路径匹配、是否包含 query/hash 等。
function createCurrentLocation (
  // base：应用的 base URL，例如 /app/ 或 /#/
  // location：浏览器的 window.location，包含 pathname, search, hash
  // renderedPath：用于 CSR/SSR 比对的路径，避免重复跳转
  base: string,
  location: Location,
  renderedPath?: string,
): string {
  const { pathname, search, hash } = location
  // allows hash bases like #, /#, #/, #!, #!/, /#!/, or even /folder#end
  // 若 base 包含 #，说明是 Hash 模式，例如 /base/#/about
  // 提取出 hash 中真正的路径部分
  // 使用 withoutBase() 去除 base 前缀，得到相对路径
  // 例：
  // location.hash = "#/about"
  // base = "/#/"
  // → return "/about"
  const hashPos = base.indexOf('#')
  if (hashPos > -1) {
    const slicePos = hash.includes(base.slice(hashPos))
      ? base.slice(hashPos).length
      : 1
    let pathFromHash = hash.slice(slicePos)
    // prepend the starting slash to hash so the url starts with /#
    if (pathFromHash[0] !== '/') { pathFromHash = '/' + pathFromHash }
    return withoutBase(pathFromHash, '')
  }

  // 非 Hash 模式处理：提取 pathname
  // 去除 base，获得实际路径，例如：
  // pathname = "/app/about"
  // base = "/app"
  // → displayedPath = "/about"
  const displayedPath = withoutBase(pathname, base)
  // 若未传入 renderedPath（即首次渲染），使用 displayedPath
  // 若传了 renderedPath，但路径相等（忽略尾部 /），也用 displayedPath
  // 否则说明 CSR 和 SSR 不一致，用传入的 renderedPath
  const path = !renderedPath || isEqual(displayedPath, renderedPath, { trailingSlash: true }) ? displayedPath : renderedPath
  // 返回最终完整路径：加上 search 和 hash
  // 拼接 query 和 hash，例如：
  // /about → /about?foo=1#top
  // 注意：若路径已含 ?，就跳过 search
  return path + (path.includes('?') ? '' : search) + hash
}

const plugin: Plugin<{ router: Router }> = defineNuxtPlugin({
  name: 'nuxt:router',
  enforce: 'pre',
  async setup (nuxtApp) {

    // 取出配置的 app.baseURL（默认为 /）
    // 如果启用了 hashMode 且未包含 #，自动补上 #
    // 示例：/myapp → /myapp# → 生成完整路径如 /myapp#/about
    let routerBase = useRuntimeConfig().app.baseURL
    if (hashMode && !routerBase.includes('#')) {
      // allow the user to provide a `#` in the middle: `/base/#/app`
      routerBase += '#'
    }

    // 优先使用用户提供的 routerOptions.history(...)。
    // 否则判断当前平台：
    // 浏览器（客户端）：
    // hashMode: true → createWebHashHistory
    // 否则 → createWebHistory
    // 非浏览器（SSR 或测试）→ createMemoryHistory
    const history = routerOptions.history?.(routerBase) ?? (import.meta.client
      ? (hashMode ? createWebHashHistory(routerBase) : createWebHistory(routerBase))
      : createMemoryHistory(routerBase)
    )

    // _routes 是 Nuxt 自动扫描 pages/ 生成的路由结构。
    // 若用户提供 routerOptions.routes(...) 自定义处理，则使用它。
    // 用【route option】还是 pages解析出来的【_routes】，在这里判断
    const routes = routerOptions.routes ? await routerOptions.routes(_routes) ?? _routes : _routes

    let startPosition: Parameters<RouterScrollBehavior>[2] | null

    // 创建 Router 实例（核心）
    const router = createRouter({
      ...routerOptions,
      // 场景	--- 处理逻辑
      // 首次导航 --- (from === START_LOCATION)	保存滚动位置
      // 后续导航	--- 使用用户自定义 scrollBehavior
      // 启用浏览器原生滚动还原	--- 设置为 manual，避免冲突
      scrollBehavior: (to, from, savedPosition) => {
        if (from === START_LOCATION) {
          startPosition = savedPosition
          return
        }
        if (routerOptions.scrollBehavior) {
          // reset scroll behavior to initial value
          router.options.scrollBehavior = routerOptions.scrollBehavior
          if ('scrollRestoration' in window.history) {
            const unsub = router.beforeEach(() => {
              unsub()
              window.history.scrollRestoration = 'manual'
            })
          }
          return routerOptions.scrollBehavior(to, START_LOCATION, startPosition || savedPosition)
        }
      },
      history,
      routes,
    })

    // 启用路由模块的 HMR。
    // 如果用户自定义了 routerOptions.routes，传入处理器；否则使用默认值。
    // Nuxt 会在页面/路由文件变化时自动更新路由配置。
    handleHotUpdate(router, routerOptions.routes ? routerOptions.routes : routes => routes)

    // 设置浏览器原生的滚动恢复行为为 auto（刷新或后退后保留滚动位置）。
    if (import.meta.client && 'scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'auto'
    }

    // 标准 vue-router 注册流程：让所有组件都能用 useRoute() / useRouter()。
    nuxtApp.vueApp.use(router)

    // 使用 afterEach 钩子记录上一个路由。
    // 通过 app.config.globalProperties.previousRoute 提供给组件访问。
    const previousRoute = shallowRef(router.currentRoute.value)
    router.afterEach((_to, from) => {
      previousRoute.value = from
    })

    Object.defineProperty(nuxtApp.vueApp.config.globalProperties, 'previousRoute', {
      get: () => previousRoute.value,
    })

    // SSR 下使用 ssrContext.url
    // 客户端根据 window.location 和 payload.path 计算当前 URL（支持 hash、baseURL）
    const initialURL = import.meta.server
      ? nuxtApp.ssrContext!.url
      : createCurrentLocation(routerBase, window.location, nuxtApp.payload.path)

    // Allows suspending the route object until page navigation completes
    // _route 是 Nuxt 中扩展的 route 状态，支持更细粒度的组件更新控制。
    // 绑定到 page:finish 生命周期，确保跳转完成后同步。
    const _route = shallowRef(router.currentRoute.value)
    const syncCurrentRoute = () => { _route.value = router.currentRoute.value }
    nuxtApp.hook('page:finish', syncCurrentRoute)
    router.afterEach((to, from) => {
      // We won't trigger suspense if the component is reused between routes
      // so we need to update the route manually
      if (to.matched[0]?.components?.default === from.matched[0]?.components?.default) {
        syncCurrentRoute()
      }
    })

    // https://github.com/vuejs/router/blob/8487c3e18882a0883e464a0f25fb28fa50eeda38/packages/router/src/router.ts#L1283-L1289
    // 为 Nuxt 内部使用创建 _route 对象，它是响应式代理，自动同步当前路由
    // shallowReactive() 提供性能优化，避免深层响应追踪。
    const route = {} as RouteLocationNormalizedLoaded
    for (const key in _route.value) {
      Object.defineProperty(route, key, {
        get: () => _route.value[key as keyof RouteLocation],
        enumerable: true,
      })
    }

    nuxtApp._route = shallowReactive(route)

    // 为路由前置守卫使用的中间件系统初始化容器：
    // global: 全局中间件数组
    // named: 命名中间件映射表，如 { auth: fn }
    nuxtApp._middleware ||= {
      global: [],
      named: {},
    }

    // 使用 Nuxt 内置 useError() 获取当前错误状态，用于后续判断是否清除错误。
    const error = useError()
    // 仅在客户端或非 Island SSR 渲染时执行以下 afterEach 钩子。Island 模式下跳过后续逻辑。
    if (import.meta.client || !nuxtApp.ssrContext?.islandContext) {
      // 注册路由跳转完成后的钩子函数，处理错误清理与 SSR 特殊行为。
      router.afterEach(async (to, _from, failure) => {
        // 清除中间件处理标记，表示本次页面跳转中间件已结束。
        delete nuxtApp._processingMiddleware

        // 如果在客户端且不是 hydration 阶段，并且存在错误：
        // 清除旧的错误（例如前一个页面的 404）
        if (import.meta.client && !nuxtApp.isHydrating && error.value) {
          // Clear any existing errors
          await nuxtApp.runWithContext(clearError)
        }
        // 如果路由跳转失败，触发 page:loading:end 钩子，用于结束 loading 状态。
        if (failure) {
          await nuxtApp.callHook('page:loading:end')
        }
        // SSR 中若失败原因是跳转被中止（如 router.push(...) 中止），则不做额外处理。
        if (import.meta.server && failure?.type === 4 /* ErrorTypes.NAVIGATION_ABORTED */) {
          return
        }

        // SSR 中若当前路由发生重定向，且目标地址与初始 URL 不一致，则执行重跳转。
        if (import.meta.server && to.redirectedFrom && to.fullPath !== initialURL) {
          await nuxtApp.runWithContext(() => navigateTo(to.fullPath || '/'))
        }
      })
    }

    // SSR 时手动 push 跳转到请求地址。
    // 等待 router 准备完成（加载异步组件等）。
    // 捕获异常（通常是页面不存在 → 显示 404）。
    try {
      if (import.meta.server) {
        await router.push(initialURL)
      }
      await router.isReady()
    } catch (error: any) {
      // We'll catch 404s here
      await nuxtApp.runWithContext(() => showError(error))
    }

    // 客户端中如果初始化路径与当前 router 不一致（hydration 后路径不一致），则重新 resolve。
    const resolvedInitialRoute = import.meta.client && initialURL !== router.currentRoute.value.fullPath
      ? router.resolve(initialURL)
      : router.currentRoute.value

    // 同步 _route 的响应式状态，更新当前路由对象。
    syncCurrentRoute()

    // 如果当前在 Island SSR 环境中，直接返回 router 实例。
    // 跳过完整的中间件、导航、重定向处理逻辑，提升性能。
    if (import.meta.server && nuxtApp.ssrContext?.islandContext) {
      // We're in an island context, and don't need to handle middleware or redirections
      return { provide: { router } }
    }

    // 从 SSR payload 中获取最初渲染页面使用的布局，用于 hydration 阶段设置 layout。
    const initialLayout = nuxtApp.payload.state._layout
    // 注册路由跳转前的钩子函数，用于处理：
    // 页面 loading 状态
    // 页面布局注入
    // 中间件收集与执行
    // 页面导航控制（拦截、重定向、报错）
    router.beforeEach(async (to, from) => {
      // 启动页面加载状态，可以用于显示加载动画或进度条。
      await nuxtApp.callHook('page:loading:start')
      // 将当前目标路由的 meta 设置为响应式，以便后续中间件或组件能动态修改。
      to.meta = reactive(to.meta)

      // 如果当前在 hydration（客户端激活）阶段，使用 SSR 生成的 layout 设置目标页面 layout。
      // 避免 hydration mismatch。
      // 确保客户端 layout 与 SSR 一致。
      if (nuxtApp.isHydrating && initialLayout && !isReadonly(to.meta.layout)) {
        to.meta.layout = initialLayout as Exclude<PageMeta['layout'], Ref | false>
      }
      // 标记当前正在处理中间件，用于后续状态判断或逻辑控制。
      nuxtApp._processingMiddleware = true

      // 如果是客户端，或者是完整 SSR（非 island 渲染），就继续处理中间件。
      if (import.meta.client || !nuxtApp.ssrContext?.islandContext) {
        // 中间件类型可能是字符串（命名）或函数（匿名） 初始中间件集合包含：
        // Nuxt 内部全局中间件 globalMiddleware
        // 用户注册的全局中间件 nuxtApp._middleware.global
        type MiddlewareDef = string | RouteMiddleware
        const middlewareEntries = new Set<MiddlewareDef>([...globalMiddleware, ...nuxtApp._middleware.global])
        // 遍历当前路由匹配到的所有组件
        // 从组件 meta.middleware 中提取中间件
        // 加入集合中，去重合并
        for (const component of to.matched) {
          const componentMiddleware = component.meta.middleware as MiddlewareDef | MiddlewareDef[]
          if (!componentMiddleware) { continue }
          for (const entry of toArray(componentMiddleware)) {
            middlewareEntries.add(entry)
          }
        }

        // 如果启用了 appManifest，则根据 routeRules 添加或移除中间件
        if (isAppManifestEnabled) {
          const routeRules = await nuxtApp.runWithContext(() => getRouteRules({ path: to.path }))

          if (routeRules.appMiddleware) {
            for (const key in routeRules.appMiddleware) {
              if (routeRules.appMiddleware[key]) {
                middlewareEntries.add(key)
              } else {
                middlewareEntries.delete(key)
              }
            }
          }
        }

        // 对于命名中间件：尝试加载已注册的函数，若没有则动态导入（lazy load）。 对于匿名函数中间件：直接使用。
        for (const entry of middlewareEntries) {
          const middleware = typeof entry === 'string' ? nuxtApp._middleware.named[entry] || await namedMiddleware[entry]?.().then((r: any) => r.default || r) : entry

          // 未找到中间件报错（含 dev 提示）
          if (!middleware) {
            if (import.meta.dev) {
              throw new Error(`Unknown route middleware: '${entry}'. Valid middleware: ${Object.keys(namedMiddleware).map(mw => `'${mw}'`).join(', ')}.`)
            }
            throw new Error(`Unknown route middleware: '${entry}'.`)
          }

          // 执行中间件逻辑
          // 使用 runWithContext 确保中间件执行在正确上下文中（包含 app hooks、错误处理等）
          const result = await nuxtApp.runWithContext(() => middleware(to, from))

          // 如果中间件返回 false 或错误对象：
          // 在 SSR 或 hydration 时直接中止导航，显示错误页
          // 例如找不到页面、未通过权限验证等
          if (import.meta.server || (!nuxtApp.payload.serverRendered && nuxtApp.isHydrating)) {
            if (result === false || result instanceof Error) {
              const error = result || createError({
                statusCode: 404,
                statusMessage: `Page Not Found: ${initialURL}`,
              })
              await nuxtApp.runWithContext(() => showError(error))
              return false
            }
          }

          // 返回中间件结果（支持重定向）
          if (result === true) { continue }
          if (result || result === false) {
            return result
          }
        }
      }
    })

    // 监听全局路由错误（如 throw 或重定向失败）：
    // 清除 _processingMiddleware 状态
    // 调用 page:loading:end 钩子，结束 loading 状态
    router.onError(async () => {
      delete nuxtApp._processingMiddleware
      await nuxtApp.callHook('page:loading:end')
    })

    // 如果导航目标没有匹配到任何页面组件（即 to.matched.length === 0），视为 404：
    // 使用 showError() 显示 Nuxt 错误页
    // 构造一个标准的 404 错误对象
    router.afterEach(async (to, _from) => {
      if (to.matched.length === 0) {
        await nuxtApp.runWithContext(() => showError(createError({
          statusCode: 404,
          fatal: false,
          statusMessage: `Page not found: ${to.fullPath}`,
          data: {
            path: to.fullPath,
          },
        })))
      }
    })

    // 在客户端首次创建 app 时触发：
    // 清除 resolvedInitialRoute.name，避免 name-based 路由 diff 错误（#4920/#4982）
    // 使用 router.replace(..., force: true) 强制更新当前路由状态，以避免与 SSR 不一致
    // 重设 scrollBehavior（防止跳转中覆盖）
    // 若跳转失败（如中间件报错），也会捕获并显示错误页面
    nuxtApp.hooks.hookOnce('app:created', async () => {
      try {
        // #4920, #4982
        if ('name' in resolvedInitialRoute) {
          resolvedInitialRoute.name = undefined
        }
        await router.replace({
          ...resolvedInitialRoute,
          force: true,
        })
        // reset scroll behavior to initial value
        router.options.scrollBehavior = routerOptions.scrollBehavior
      } catch (error: any) {
        // We'll catch middleware errors or deliberate exceptions here
        await nuxtApp.runWithContext(() => showError(error))
      }
    })

    // 最终将 Vue Router 实例作为依赖注入提供（供组件 useRouter() 等使用）
    return { provide: { router } }
  },
})

export default plugin
