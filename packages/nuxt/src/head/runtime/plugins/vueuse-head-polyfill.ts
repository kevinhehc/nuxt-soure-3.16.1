import type { UseHeadInput, UseHeadOptions, VueHeadClient } from '@unhead/vue'
import { defineNuxtPlugin } from '#app/nuxt'
import { useHead } from '#app/composables/head'

// 为 @unhead/vue 提供 @vueuse/head 风格的 API 兼容层，避免第三方库（如 VueUse）在使用旧 API 时报错或失效。

export type VueHeadClientPollyFill = VueHeadClient & {
  /**
   * @deprecated use `resolveTags`
   */
  headTags: VueHeadClient['resolveTags']
  /**
   * @deprecated use `push`
   */
  addEntry: VueHeadClient['push']
  /**
   * @deprecated use `push`
   */
  addHeadObjs: VueHeadClient['push']
  /**
   * @deprecated use `useHead`
   */
  addReactiveEntry: (input: UseHeadInput, options?: UseHeadOptions) => (() => void)
  /**
   * @deprecated Use useHead API.
   */
  removeHeadObjs: () => void
  /**
   * @deprecated Call hook `entries:resolve` or update an entry
   */
  updateDOM: () => void
  /**
   * @deprecated Access unhead properties directly.
   */
  unhead: VueHeadClient
}

/**
 * @deprecated Will be removed in Nuxt v4.
 */
// 接收一个 VueHeadClient 实例（即 @unhead/vue 创建的 head 实例）；
// 在其原型上动态添加兼容函数；
// 返回带有“旧 API 名称”的增强版 head。
function polyfillAsVueUseHead (head: VueHeadClient): VueHeadClientPollyFill {
  const polyfilled = head as VueHeadClientPollyFill
  // add a bunch of @vueuse/head compat functions
  polyfilled.headTags = head.resolveTags
  polyfilled.addEntry = head.push
  polyfilled.addHeadObjs = head.push
  polyfilled.addReactiveEntry = (input, options) => {
    const api = useHead(input, options)
    if (api !== undefined) { return api.dispose }
    return () => {}
  }
  // not able to handle this
  polyfilled.removeHeadObjs = () => {}
  // trigger DOM
  polyfilled.updateDOM = () => {
    head.hooks.callHook('entries:updated', head)
  }
  polyfilled.unhead = head
  return polyfilled
}

export default defineNuxtPlugin({
  name: 'nuxt:vueuse-head-polyfill',
  setup (nuxtApp) {
    // avoid breaking ecosystem dependencies using low-level @vueuse/head APIs
    polyfillAsVueUseHead(nuxtApp.vueApp._context.provides.usehead)
  },
})
