import type { ActiveHeadEntry, UseHeadInput, UseHeadOptions, UseHeadSafeInput, UseSeoMetaInput, VueHeadClient } from '@unhead/vue'
import { hasInjectionContext, inject } from 'vue'
import {
  useHead as headCore,
  useHeadSafe as headSafe,
  headSymbol,
  useSeoMeta as seoMeta, useServerHead as serverHead, useServerHeadSafe as serverHeadSafe,
  useServerSeoMeta as serverSeoMeta,
} from '@unhead/vue'
import { tryUseNuxtApp } from '#app/nuxt'
import type { NuxtApp } from '#app/nuxt'

// 在 Nuxt 中使用 <head> 标签的推荐方式，自动注入 head 实例并调用 @unhead/vue 提供的核心功能。

/**
 * Injects the head client from the Nuxt context or Vue inject.
 *
 * In Nuxt v3 this function will not throw an error if the context is missing.
 */
// 从 Nuxt 上下文中获取 head 实例（VueHeadClient）；
// 如果未传入上下文，会尝试使用当前 NuxtApp 或 Vue 的依赖注入。
export function injectHead (nuxtApp?: NuxtApp): VueHeadClient {
  // Nuxt 4 will throw an error if the context is missing
  // SSR 时从 nuxt.ssrContext.head 中取；
  // 客户端或插件中用 Vue inject() 获取；
  // 不会抛错，找不到就返回 undefined（容错）。
  const nuxt = nuxtApp || tryUseNuxtApp()
  return nuxt?.ssrContext?.head || nuxt?.runWithContext(() => {
    if (hasInjectionContext()) {
      return inject<VueHeadClient>(headSymbol)!
    }
  }) as VueHeadClient
}

interface NuxtUseHeadOptions extends UseHeadOptions {
  nuxt?: NuxtApp
}

// 注册一个 <head> 配置（如 title, meta, link 等）；
// 可在组件、布局、插件等地方使用；
// 自动注入 Nuxt 上下文中的 head 客户端对象。
export function useHead (input: UseHeadInput, options: NuxtUseHeadOptions = {}): ActiveHeadEntry<UseHeadInput> | void {
  const head = injectHead(options.nuxt)
  if (head) {
    return headCore(input, { head, ...options }) as ActiveHeadEntry<UseHeadInput>
  }
}

export function useHeadSafe (input: UseHeadSafeInput, options: NuxtUseHeadOptions = {}): ActiveHeadEntry<UseHeadSafeInput> | void {
  const head = injectHead(options.nuxt)
  if (head) {
    return headSafe(input, { head, ...options }) as ActiveHeadEntry<UseHeadSafeInput>
  }
}

export function useSeoMeta (input: UseSeoMetaInput, options: NuxtUseHeadOptions = {}): ActiveHeadEntry<UseSeoMetaInput> | void {
  const head = injectHead(options.nuxt)
  if (head) {
    return seoMeta(input, { head, ...options }) as ActiveHeadEntry<UseHeadInput>
  }
}

export function useServerHead (input: UseHeadInput, options: NuxtUseHeadOptions = {}): ActiveHeadEntry<UseHeadInput> | void {
  const head = injectHead(options.nuxt)
  if (head) {
    return serverHead(input, { head, ...options }) as ActiveHeadEntry<UseHeadInput>
  }
}

export function useServerHeadSafe (input: UseHeadSafeInput, options: NuxtUseHeadOptions = {}): ActiveHeadEntry<UseHeadSafeInput> | void {
  const head = injectHead(options.nuxt)
  if (head) {
    return serverHeadSafe(input, { head, ...options }) as ActiveHeadEntry<UseHeadSafeInput>
  }
}

export function useServerSeoMeta (input: UseSeoMetaInput, options: NuxtUseHeadOptions = {}): ActiveHeadEntry<UseSeoMetaInput> | void {
  const head = injectHead(options.nuxt)
  if (head) {
    return serverSeoMeta(input, { head, ...options }) as ActiveHeadEntry<UseSeoMetaInput>
  }
}
