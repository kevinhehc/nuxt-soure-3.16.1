import { onScopeDispose } from 'vue'
import type { HookCallback } from 'hookable'
import { useNuxtApp } from '../nuxt'
import type { RuntimeNuxtHooks } from '../nuxt'

/**
 * Registers a runtime hook in a Nuxt application and ensures it is properly disposed of when the scope is destroyed.
 * @param name - The name of the hook to register.
 * @param fn - The callback function to be executed when the hook is triggered.
 * @since 3.14.0
 */
// 组合式 API（setup 函数、composables 里面）注册 Nuxt Runtime Hooks 的辅助函数。
// 并且自动在作用域结束时清理 (unregister)，防止泄露！
export function useRuntimeHook<THookName extends keyof RuntimeNuxtHooks> (
  // THookName 是 RuntimeNuxtHooks 中的一个 key，例如：
  // 'app:created'
  // 'page:start'
  // 'app:error'
  // 等等。
  name: THookName,
  fn: RuntimeNuxtHooks[THookName] extends HookCallback ? RuntimeNuxtHooks[THookName] : never,
): void {
  const nuxtApp = useNuxtApp()

  const unregister = nuxtApp.hook(name, fn)

  onScopeDispose(unregister)
}
