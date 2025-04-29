import { defineComponent, getCurrentInstance, h, ref } from 'vue'
import NuxtIsland from '#app/components/nuxt-island'
import { useRoute } from '#app/composables/router'
import { isPrerendered } from '#app/composables/payload'
import { createError, showError } from '#app/composables/error'
import { useNuxtApp } from '#app/nuxt'

/* @__NO_SIDE_EFFECTS__ */
// 按需渲染的服务端组件
// 创建一个 仅在服务端渲染的组件包裹器，内部使用 <NuxtIsland> 组件来渲染指定的 "island"，并支持：
// 延迟加载（通过 lazy prop）
// 错误处理（通过 @error）
// 手动刷新（通过 expose().refresh()）
// 这个组件可被用作局部 SSR 渲染输出，并不参与客户端 hydration，提高页面性能。
export const createServerComponent = (name: string) => {
  return defineComponent({
    name,
    inheritAttrs: false,
    props: { lazy: Boolean },
    emits: ['error'],
    setup (props, { attrs, slots, expose, emit }) {
      const vm = getCurrentInstance()
      const islandRef = ref<null | typeof NuxtIsland>(null)

      expose({
        refresh: () => islandRef.value?.refresh(),
      })

      return () => {
        return h(NuxtIsland, {
          name,
          lazy: props.lazy,
          props: attrs,
          scopeId: vm?.vnode.scopeId,
          ref: islandRef,
          onError: (err) => {
            emit('error', err)
          },
        }, slots)
      }
    },
  })
}

/* @__NO_SIDE_EFFECTS__ */
// 用于将 整个页面当作 island（SSR 段）来渲染，并通过 NuxtIsland：
// 根据当前路由渲染内容（包括 hash 清理）
// 在客户端触发错误处理（结合 useError）
// 也支持 .refresh() 方法暴露
// 适用于 嵌套子页面、嵌套子布局 或 Prerender 场景下的异步页面内容注入。
export const createIslandPage = (name: string) => {
  return defineComponent({
    name,
    inheritAttrs: false,
    props: { lazy: Boolean },
    async setup (props, { slots, expose }) {
      const islandRef = ref<null | typeof NuxtIsland>(null)

      expose({
        refresh: () => islandRef.value?.refresh(),
      })
      const nuxtApp = useNuxtApp()
      const route = useRoute()
      const path = import.meta.client && await isPrerendered(route.path) ? route.path : route.fullPath.replace(/#.*$/, '')
      return () => {
        return h('div', [
          h(NuxtIsland, {
            name: `page_${name}`,
            lazy: props.lazy,
            ref: islandRef,
            context: { url: path },
            onError: (e) => {
              if (e.cause && e.cause instanceof Response) {
                throw createError({
                  statusCode: e.cause.status,
                  statusText: e.cause.statusText,
                  status: e.cause.status,
                })
              }
              nuxtApp.runWithContext(() => showError(e))
            },
          }, slots),
        ])
      }
    },
  })
}
