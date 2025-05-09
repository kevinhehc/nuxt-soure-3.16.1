import { h, onMounted, ref } from 'vue'
import type { AsyncComponentLoader, ComponentOptions } from 'vue'
import { isPromise } from '@vue/shared'
import { useNuxtApp } from '#app/nuxt'
import ServerPlaceholder from '#app/components/server-placeholder'

// 处理 client-only page（客户端专属页面） 的底层机制。
// createClientPage + pageToClientOnly 用来将页面组件包装成只在客户端真正渲染的组件，
// 在服务器端渲染（SSR）期间，只显示一个空的 <div> 占位符，从而支持「客户端专属页面」。

/* @__NO_SIDE_EFFECTS__ */
export async function createClientPage (loader: AsyncComponentLoader) {
  // vue-router: Write "() => import('./MyPage.vue')" instead of "defineAsyncComponent(() => import('./MyPage.vue'))".
  const m = await loader()
  const c = m.default || m
  if (import.meta.dev) {
    // mark component as client-only for `definePageMeta`
    c.__clientOnlyPage = true
  }
  return pageToClientOnly(c)
}

const cache = new WeakMap()

function pageToClientOnly<T extends ComponentOptions> (component: T) {
  if (import.meta.server) {
    // 如果在服务器端 (import.meta.server === true)：
    // 返回一个 ServerPlaceholder，就是 <div></div>。
    // 页面上只看到一个空白 div（不会报错，不会执行 localStorage）。
    return ServerPlaceholder
  }

  // 如果在浏览器端：
  // 页面挂载完成后，执行真正的组件 setup 和 render。
  // 正常显示用户信息。

  if (cache.has(component)) {
    return cache.get(component)
  }

  const clone = { ...component }

  if (clone.render) {
    // override the component render (non script setup component) or dev mode
    clone.render = (ctx: any, cache: any, $props: any, $setup: any, $data: any, $options: any) => ($setup.mounted$ ?? ctx.mounted$)
      ? h(component.render?.bind(ctx)(ctx, cache, $props, $setup, $data, $options))
      : h('div')
  } else {
    // handle runtime-compiler template
    clone.template &&= `
      <template v-if="mounted$">${component.template}</template>
      <template v-else><div></div></template>
    `
  }

  clone.setup = (props, ctx) => {
    const nuxtApp = useNuxtApp()
    const mounted$ = ref(nuxtApp.isHydrating === false)
    onMounted(() => {
      mounted$.value = true
    })
    const setupState = component.setup?.(props, ctx) || {}
    if (isPromise(setupState)) {
      return Promise.resolve(setupState).then((setupState: any) => {
        if (typeof setupState !== 'function') {
          setupState ||= {}
          setupState.mounted$ = mounted$
          return setupState
        }
        return (...args: any[]) => (mounted$.value || !nuxtApp.isHydrating) ? h(setupState(...args)) : h('div')
      })
    } else {
      return typeof setupState === 'function'
        ? (...args: any[]) => (mounted$.value || !nuxtApp.isHydrating)
            ? h(setupState(...args))
            : h('div')
        : Object.assign(setupState, { mounted$ })
    }
  }

  cache.set(component, clone)

  return clone
}
