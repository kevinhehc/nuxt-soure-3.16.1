import type { NuxtHooks, NuxtMiddleware } from '@nuxt/schema'
import type { NitroRouteConfig } from 'nitropack'
import { defu } from 'defu'
import { useNuxt } from './context'
import { isNuxt2 } from './compatibility'
import { logger } from './logger'
import { toArray } from './utils'

// 用于在模块或插件开发时动态扩展路由、路由规则、以及路由中间件的标准方法。
//
// 主要负责：
//
// 动态修改或增加 pages 路由
//
// 动态修改路由规则 (Route Rules)
//
// 动态添加中间件 (Middleware)


export function extendPages (cb: NuxtHooks['pages:extend']) {
  const nuxt = useNuxt()
  if (isNuxt2(nuxt)) {
    // @ts-expect-error TODO: Nuxt 2 hook
    nuxt.hook('build:extendRoutes', cb)
  } else {
    nuxt.hook('pages:extend', cb)
  }
}

export interface ExtendRouteRulesOptions {
  /**
   * Override route rule config
   * @default false
   */
  override?: boolean
}

export function extendRouteRules (route: string, rule: NitroRouteConfig, options: ExtendRouteRulesOptions = {}) {
  const nuxt = useNuxt()
  for (const opts of [nuxt.options, nuxt.options.nitro]) {
    opts.routeRules ||= {}
    opts.routeRules[route] = options.override
      ? defu(rule, opts.routeRules[route])
      : defu(opts.routeRules[route], rule)
  }
}

export interface AddRouteMiddlewareOptions {
  /**
   * Override existing middleware with the same name, if it exists
   * @default false
   */
  override?: boolean
  /**
   * Prepend middleware to the list
   * @default false
   */
  prepend?: boolean
}

export function addRouteMiddleware (input: NuxtMiddleware | NuxtMiddleware[], options: AddRouteMiddlewareOptions = {}) {
  const nuxt = useNuxt()
  const middlewares = toArray(input)
  nuxt.hook('app:resolve', (app) => {
    for (const middleware of middlewares) {
      const find = app.middleware.findIndex(item => item.name === middleware.name)
      if (find >= 0) {
        const foundPath = app.middleware[find]!.path
        if (foundPath === middleware.path) { continue }
        if (options.override === true) {
          app.middleware[find] = { ...middleware }
        } else {
          logger.warn(`'${middleware.name}' middleware already exists at '${foundPath}'. You can set \`override: true\` to replace it.`)
        }
      } else if (options.prepend === true) {
        app.middleware.unshift({ ...middleware })
      } else {
        app.middleware.push({ ...middleware })
      }
    }
  })
}
