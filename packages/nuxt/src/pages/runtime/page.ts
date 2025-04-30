import { Fragment, Suspense, defineComponent, h, inject, nextTick, ref, watch } from 'vue'
import type { AllowedComponentProps, Component, ComponentCustomProps, ComponentPublicInstance, KeepAliveProps, Slot, TransitionProps, VNode, VNodeProps } from 'vue'
import { RouterView } from 'vue-router'
import { defu } from 'defu'
import type { RouteLocationNormalized, RouteLocationNormalizedLoaded, RouterViewProps } from 'vue-router'

import { generateRouteKey, toArray, wrapInKeepAlive } from './utils'
import type { RouterViewSlotProps } from './utils'
import { RouteProvider, defineRouteProvider } from '#app/components/route-provider'
import { useNuxtApp } from '#app/nuxt'
import { useRouter } from '#app/composables/router'
import { _wrapInTransition } from '#app/components/utils'
import { LayoutMetaSymbol, PageRouteSymbol } from '#app/components/injections'
// @ts-expect-error virtual file
import { appKeepalive as defaultKeepaliveConfig, appPageTransition as defaultPageTransition } from '#build/nuxt.config.mjs'

export interface NuxtPageProps extends RouterViewProps {
  // transition: 控制页面的过渡动画，可以为 boolean 或 TransitionProps（如 enter/leave 钩子）。
  // keepalive: 控制是否缓存页面，可以为布尔值或 KeepAliveProps（如 include/exclude）。
  // pageKey: 控制页面重新渲染的方式。可以是固定字符串，也可以是函数，动态计算 key。
  /**
   * Define global transitions for all pages rendered with the `NuxtPage` component.
   */
  transition?: boolean | TransitionProps

  /**
   * Control state preservation of pages rendered with the `NuxtPage` component.
   */
  keepalive?: boolean | KeepAliveProps

  /**
   * Control when the `NuxtPage` component is re-rendered.
   */
  pageKey?: string | ((route: RouteLocationNormalizedLoaded) => string)
}

export default defineComponent({
  // 使用 defineComponent 定义组件，并关闭默认属性继承。
  name: 'NuxtPage',
  inheritAttrs: false,
  // 这些 props 提供灵活的页面渲染控制选项，包括命名视图、过渡、缓存及 key 控制。
  props: {
    name: {
      type: String,
    },
    transition: {
      type: [Boolean, Object] as any as () => boolean | TransitionProps,
      default: undefined,
    },
    keepalive: {
      type: [Boolean, Object] as any as () => boolean | KeepAliveProps,
      default: undefined,
    },
    route: {
      type: Object as () => RouteLocationNormalized,
    },
    pageKey: {
      type: [Function, String] as unknown as () => string | ((route: RouteLocationNormalizedLoaded) => string),
      default: null,
    },
  },
  setup (props, { attrs, slots, expose }) {
    // 通过 useNuxtApp() 获取 Nuxt 实例。
    // 定义 pageRef 用于页面组件引用，并通过 expose() 暴露出去供外部访问。
    const nuxtApp = useNuxtApp()
    const pageRef = ref()
    // forkRoute：表示路由分叉的历史记录，用于处理 <NuxtLayout> 下的页面切换。
    // _layoutMeta：用于判断当前路由是否在同一个 layout 下，防止 layout 内重复渲染。
    const forkRoute = inject(PageRouteSymbol, null)
    let previousPageKey: string | undefined | false

    expose({ pageRef })

    const _layoutMeta = inject(LayoutMetaSymbol, null)
    let vnode: VNode

    // deferHydration() 延迟页面挂载直到异步数据加载完成。
    // 如果正在 hydration，监听 app:error 事件结束挂载。
    const done = nuxtApp.deferHydration()
    if (import.meta.client && nuxtApp.isHydrating) {
      const removeErrorHook = nuxtApp.hooks.hookOnce('app:error', done)
      useRouter().beforeEach(removeErrorHook)
    }

    // 如果 pageKey 改变（例如动态切换 key），触发 page:loading:start 钩子。
    if (props.pageKey) {
      watch(() => props.pageKey, (next, prev) => {
        if (next !== prev) {
          nuxtApp.callHook('page:loading:start')
        }
      })
    }

    // 开发模式标记
    if (import.meta.dev) {
      nuxtApp._isNuxtPageUsed = true
    }
    let pageLoadingEndHookAlreadyCalled = false

    const routerProviderLookup = new WeakMap<Component, ReturnType<typeof defineRouteProvider> | undefined>()

    // 渲染 RouterView，并提供默认插槽以实现自定义页面包裹逻辑。
    // routeProps.Component 表示当前路由对应的页面组件。
    return () => {
      return h(RouterView, { name: props.name, route: props.route, ...attrs }, {
        default: (routeProps: RouterViewSlotProps) => {
          const isRenderingNewRouteInOldFork = import.meta.client && haveParentRoutesRendered(forkRoute, routeProps.route, routeProps.Component)
          const hasSameChildren = import.meta.client && forkRoute && forkRoute.matched.length === routeProps.route.matched.length

          // 异常情况：未能解析出组件
          if (!routeProps.Component) {
            // If we're rendering a `<NuxtPage>` child route on navigation to a route which lacks a child page
            // we'll render the old vnode until the new route finishes resolving
            if (import.meta.client && vnode && !hasSameChildren) {
              return vnode
            }
            done()
            return
          }

          // Return old vnode if we are rendering _new_ page suspense fork in _old_ layout suspense fork
          if (import.meta.client && vnode && _layoutMeta && !_layoutMeta.isCurrent(routeProps.route)) {
            return vnode
          }

          if (import.meta.client && isRenderingNewRouteInOldFork && forkRoute && (!_layoutMeta || _layoutMeta?.isCurrent(forkRoute))) {
            // if leaving a route with an existing child route, render the old vnode
            if (hasSameChildren) {
              return vnode
            }
            // If _leaving_ null child route, return null vnode
            return null
          }

          const key = generateRouteKey(routeProps, props.pageKey)
          if (!nuxtApp.isHydrating && !hasChildrenRoutes(forkRoute, routeProps.route, routeProps.Component) && previousPageKey === key) {
            nuxtApp.callHook('page:loading:end')
            pageLoadingEndHookAlreadyCalled = true
          }

          previousPageKey = key

          // SSR 渲染逻辑
          if (import.meta.server) {
            vnode = h(Suspense, {
              suspensible: true,
            }, {
              default: () => {
                const providerVNode = h(RouteProvider, {
                  key: key || undefined,
                  vnode: slots.default ? normalizeSlot(slots.default, routeProps) : routeProps.Component,
                  route: routeProps.route,
                  renderKey: key || undefined,
                  vnodeRef: pageRef,
                })
                return providerVNode
              },
            })

            return vnode
          }

          // Client side rendering
          const hasTransition = !!(props.transition ?? routeProps.route.meta.pageTransition ?? defaultPageTransition)
          const transitionProps = hasTransition && _mergeTransitionProps([
            props.transition,
            routeProps.route.meta.pageTransition,
            defaultPageTransition,
            { onAfterLeave: () => { nuxtApp.callHook('page:transition:finish', routeProps.Component) } },
          ].filter(Boolean))

          const keepaliveConfig = props.keepalive ?? routeProps.route.meta.keepalive ?? (defaultKeepaliveConfig as KeepAliveProps)
          // hasTransition 判断是否有过渡动画
          // transitionProps 合并组件和路由定义的过渡配置
          // keepaliveConfig 控制页面是否缓存
          // 构造一个 Suspense 包裹的页面组件，并嵌入 RouteProvider
          vnode = _wrapInTransition(hasTransition && transitionProps,
            wrapInKeepAlive(keepaliveConfig, h(Suspense, {
              suspensible: true,
              onPending: () => nuxtApp.callHook('page:start', routeProps.Component),
              onResolve: () => {
                nextTick(() => nuxtApp.callHook('page:finish', routeProps.Component).then(() => {
                  if (!pageLoadingEndHookAlreadyCalled) {
                    return nuxtApp.callHook('page:loading:end')
                  }
                  pageLoadingEndHookAlreadyCalled = false
                }).finally(done))
              },
            }, {
              default: () => {
                const routeProviderProps = {
                  key: key || undefined,
                  vnode: slots.default ? normalizeSlot(slots.default, routeProps) : routeProps.Component,
                  route: routeProps.route,
                  renderKey: key || undefined,
                  trackRootNodes: hasTransition,
                  vnodeRef: pageRef,
                }

                if (!keepaliveConfig) {
                  return h(RouteProvider, routeProviderProps)
                }

                const routerComponentType = routeProps.Component.type as any
                let PageRouteProvider = routerProviderLookup.get(routerComponentType)

                if (!PageRouteProvider) {
                  PageRouteProvider = defineRouteProvider(routerComponentType.name || routerComponentType.__name)
                  routerProviderLookup.set(routerComponentType, PageRouteProvider)
                }

                return h(PageRouteProvider, routeProviderProps)
              },
            }),
            )).default()

          return vnode
        },
      })
    }
  },
}) as unknown as {
  new(): {
    $props: AllowedComponentProps &
      ComponentCustomProps &
      VNodeProps &
      NuxtPageProps

    $slots: {
      default?: (routeProps: RouterViewSlotProps) => VNode[]
    }

    // expose
    /**
     * Reference to the page component instance
     */
    pageRef: Element | ComponentPublicInstance | null
  }
}

// 合并多个过渡配置对象。
function _mergeTransitionProps (routeProps: TransitionProps[]): TransitionProps {
  const _props: TransitionProps[] = routeProps.map(prop => ({
    ...prop,
    onAfterLeave: prop.onAfterLeave ? toArray(prop.onAfterLeave) : undefined,
  }))
  return defu(..._props as [TransitionProps, TransitionProps])
}

// 用于判断当前组件是否在路由结构的旧 layout 中被重新渲染。
function haveParentRoutesRendered (fork: RouteLocationNormalizedLoaded | null, newRoute: RouteLocationNormalizedLoaded, Component?: VNode) {
  if (!fork) { return false }

  const index = newRoute.matched.findIndex(m => m.components?.default === Component?.type)
  if (!index || index === -1) { return false }

  // we only care whether the parent route components have had to rerender
  return newRoute.matched.slice(0, index)
    .some(
      (c, i) => c.components?.default !== fork.matched[i]?.components?.default) ||
    (Component && generateRouteKey({ route: newRoute, Component }) !== generateRouteKey({ route: fork, Component }))
}

// 判断当前页面是否有子页面（用于 <NuxtPage> 的嵌套路由逻辑）。
function hasChildrenRoutes (fork: RouteLocationNormalizedLoaded | null, newRoute: RouteLocationNormalizedLoaded, Component?: VNode) {
  if (!fork) { return false }

  const index = newRoute.matched.findIndex(m => m.components?.default === Component?.type)
  return index < newRoute.matched.length - 1
}

// 将默认插槽的内容标准化为 VNode。
function normalizeSlot (slot: Slot, data: RouterViewSlotProps) {
  const slotContent = slot(data)
  return slotContent.length === 1 ? h(slotContent[0]!) : h(Fragment, undefined, slotContent)
}
