import type { RouteRecordRaw } from 'vue-router'
import { joinURL } from 'ufo'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'
import defu from 'defu'

import { defineNuxtPlugin, useRuntimeConfig } from '#app/nuxt'
import { prerenderRoutes } from '#app/composables/ssr'
import _routes from '#build/routes'
import routerOptions, { hashMode } from '#build/router.options'
// @ts-expect-error virtual file
import { crawlLinks } from '#build/nuxt.config.mjs'

// 在静态站点生成时，根据配置自动收集应该被预渲染（Prerender）的页面路径。

let routes: string[]

let _routeRulesMatcher: undefined | ReturnType<typeof toRouteMatcher> = undefined

export default defineNuxtPlugin(async () => {
  // 插件仅在以下条件下运行：
  // 当前运行在 服务端环境（import.meta.server）
  // 是 预渲染流程中（import.meta.prerender）
  // 非 hash 路由模式（因为 hash 模式没法真正 prerender）
  // 如果 routes 已经有值但是空数组，就不再处理。
  if (!import.meta.server || !import.meta.prerender || hashMode) {
    return
  }
  if (routes && !routes.length) { return }


  // routeRules 是在 nuxt.config.ts 中配置的路径规则，如：
  const routeRules = useRuntimeConfig().nitro!.routeRules
  if (!crawlLinks && routeRules && Object.values(routeRules).some(r => r.prerender)) {
    // 如果设置了某些路径需要 prerender（即 prerender: true），
    // 则生成 Radix 路由匹配器 _routeRulesMatcher，
    // 用于后续判断某个路径是否应被 prerender。
    _routeRulesMatcher = toRouteMatcher(createRadixRouter({ routes: routeRules }))
  }

  // _routes 是从 Nuxt 页面系统自动生成的完整路由表。
  // 如果有自定义 routerOptions.routes，就先调用它处理。
  // processRoutes() 会递归收集应该 prerender 的静态路径（见下方实现）。
  // 使用 Set 保证路径唯一性。
  routes ||= Array.from(processRoutes(await routerOptions.routes?.(_routes) ?? _routes))
  // 每次最多处理 10 个 prerender 路径，防止阻塞。
  // 实际的 prerenderRoutes() 会交由 Nitro 做静态 HTML 渲染。
  const batch = routes.splice(0, 10)
  prerenderRoutes(batch)
})

// Implementation

const OPTIONAL_PARAM_RE = /^\/?:.*(?:\?|\(\.\*\)\*)$/

function shouldPrerender (path: string) {
  // 用路由规则 matcher 查找该路径是否设置了 prerender: true。
  // 使用 defu()（深度合并）提取合并后的规则。
  // 如果没有规则限制，则默认全部 prerender。
  return !_routeRulesMatcher || defu({} as Record<string, any>, ..._routeRulesMatcher.matchAll(path).reverse()).prerender
}

function processRoutes (routes: readonly RouteRecordRaw[], currentPath = '/', routesToPrerender = new Set<string>()) {
  // 遍历每个路由项：
  // 如果是可选参数路由（/blog/:slug?）或 catchall，并且无子路由：也尝试 prerender 它的 root（如 /blog）。
  // 如果包含动态参数（如 :id），跳过，因为不能静态渲染。
  // 如果路径通过 shouldPrerender() 检查为 true，就加入结果集中。
  // 递归处理子路由（如嵌套路由）。
  for (const route of routes) {
    // Add root of optional dynamic paths and catchalls
    if (OPTIONAL_PARAM_RE.test(route.path) && !route.children?.length && shouldPrerender(currentPath)) {
      routesToPrerender.add(currentPath)
    }
    // Skip dynamic paths
    if (route.path.includes(':')) {
      continue
    }
    const fullPath = joinURL(currentPath, route.path)
    if (shouldPrerender(fullPath)) {
      routesToPrerender.add(fullPath)
    }
    if (route.children) {
      processRoutes(route.children, fullPath, routesToPrerender)
    }
  }
  return routesToPrerender
}
