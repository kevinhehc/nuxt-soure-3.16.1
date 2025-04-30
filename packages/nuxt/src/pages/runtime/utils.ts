import { KeepAlive, h } from 'vue'
import type { RouteLocationMatched, RouteLocationNormalizedLoaded, RouterView } from 'vue-router'

// 提取构造函数类型 T 的实例类型（即类的实例）。
// 示例：InstanceOf<typeof Date> 将会得到 Date 类型。
type InstanceOf<T> = T extends new (...args: any[]) => infer R ? R : never
// RouterViewSlot: 获取 <RouterView> 默认插槽的类型（去除 undefined）。
type RouterViewSlot = Exclude<InstanceOf<typeof RouterView>['$slots']['default'], undefined>
// RouterViewSlotProps: 获取插槽函数的参数，即 { Component, route, ... }，用于自定义页面渲染时注入的数据结构。
export type RouterViewSlotProps = Parameters<RouterViewSlot>[0]

// 这三种正则分别处理 Nuxt 路由定义中的动态参数：
// (:id)(\d+) → :id
// :slug? / :slug* / :slug+ → :slug
// 匹配所有 :param 风格参数
const ROUTE_KEY_PARENTHESES_RE = /(:\w+)\([^)]+\)/g
const ROUTE_KEY_SYMBOLS_RE = /(:\w+)[?+*]/g
const ROUTE_KEY_NORMAL_RE = /:\w+/g
// 用于将带参数的路由路径（如 /user/:id）转换为实际路径（如 /user/123）。
const interpolatePath = (route: RouteLocationNormalizedLoaded, match: RouteLocationMatched) => {
  return match.path
    .replace(ROUTE_KEY_PARENTHESES_RE, '$1')
    .replace(ROUTE_KEY_SYMBOLS_RE, '$1')
    .replace(ROUTE_KEY_NORMAL_RE, r => route.params[r.slice(1)]?.toString() || '')
}

// 作用： 为每个 <NuxtPage> 生成唯一的 key，确保在页面切换时触发重新渲染。
// 优先级：
// 用户传入的 override
// meta.key 指定的值
// 自动根据路由 path + params 插值生成
export const generateRouteKey = (routeProps: RouterViewSlotProps, override?: string | ((route: RouteLocationNormalizedLoaded) => string)) => {
  const matchedRoute = routeProps.route.matched.find(m => m.components?.default === routeProps.Component.type)
  const source = override ?? matchedRoute?.meta.key ?? (matchedRoute && interpolatePath(routeProps.route, matchedRoute))
  return typeof source === 'function' ? source(routeProps.route) : source
}


// 作用： 包裹页面组件，使其启用 Vue 的 <KeepAlive> 缓存功能。
// 当 props 为 true：使用默认配置缓存页面组件；
// 为对象：传递 include/exclude 等配置；
// 若不在客户端或 props 为 false：直接返回原组件。
export const wrapInKeepAlive = (props: any, children: any) => {
  return { default: () => import.meta.client && props ? h(KeepAlive, props === true ? {} : props, children) : children }
}

/** @since 3.9.0 */
// 作用： 确保输入一定是数组，常用于合并钩子函数或过渡属性。
export function toArray<T> (value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}
