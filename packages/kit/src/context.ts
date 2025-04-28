import { AsyncLocalStorage } from 'node:async_hooks'
import { createContext, getContext } from 'unctx'
import type { Nuxt } from '@nuxt/schema'

// 统一管理和访问当前 Nuxt 实例（Context）的方法。
//
// 它主要解决两个问题：
//
// 在任何地方都可以拿到当前运行的 Nuxt 实例。
//
// 支持在异步操作（比如 await 后面）正确保存和恢复上下文。

/**
 * Direct access to the Nuxt global context - see https://github.com/unjs/unctx.
 * @deprecated Use `getNuxtCtx` instead
 */
export const nuxtCtx = getContext<Nuxt>('nuxt')

/** async local storage for the name of the current nuxt instance */
const asyncNuxtStorage = createContext<Nuxt>({
  asyncContext: true,
  AsyncLocalStorage,
})

/** Direct access to the Nuxt context with asyncLocalStorage - see https://github.com/unjs/unctx. */
export const getNuxtCtx = () => asyncNuxtStorage.tryUse()

// TODO: Use use/tryUse from unctx. https://github.com/unjs/unctx/issues/6

/**
 * Get access to Nuxt instance.
 *
 * Throws an error if Nuxt instance is unavailable.
 * @example
 * ```js
 * const nuxt = useNuxt()
 * ```
 */
export function useNuxt (): Nuxt {
  const instance = asyncNuxtStorage.tryUse() || nuxtCtx.tryUse()
  if (!instance) {
    throw new Error('Nuxt instance is unavailable!')
  }
  return instance
}

/**
 * Get access to Nuxt instance.
 *
 * Returns null if Nuxt instance is unavailable.
 * @example
 * ```js
 * const nuxt = tryUseNuxt()
 * if (nuxt) {
 *  // Do something
 * }
 * ```
 */
export function tryUseNuxt (): Nuxt | null {
  return asyncNuxtStorage.tryUse() || nuxtCtx.tryUse()
}

export function runWithNuxtContext<T extends (...args: any[]) => any> (nuxt: Nuxt, fn: T) {
  return asyncNuxtStorage.call(nuxt, fn) as ReturnType<T>
}
