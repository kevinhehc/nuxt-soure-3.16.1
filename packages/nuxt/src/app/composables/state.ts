import { isRef, toRef } from 'vue'
import type { Ref } from 'vue'
import { useNuxtApp } from '../nuxt'
import { toArray } from '../utils'

const useStateKeyPrefix = '$s'
/**
 * Create a global reactive ref that will be hydrated but not shared across ssr requests
 * @since 3.0.0
 * @param key a unique key ensuring that data fetching can be properly de-duplicated across requests
 * @param init a function that provides initial value for the state when it's not initiated
 */
export function useState<T> (key?: string, init?: (() => T | Ref<T>)): Ref<T>
export function useState<T> (init?: (() => T | Ref<T>)): Ref<T>


// Nuxt 里面 **页面级状态管理（payload.state）**的根基
export function useState<T> (...args: any): Ref<T> {
  //定义 useState，接收任意数量的参数。
  // 返回类型是 Vue 的 Ref<T> —— 响应式的引用对象。

  // 如果最后一个参数是字符串（key），取出来当 autoKey 。
  // 支持灵活的参数顺序：useState(key, init) 或 useState(init, key) 都可以。
  const autoKey = typeof args[args.length - 1] === 'string' ? args.pop() : undefined

  // 如果第一个参数不是字符串，
  // 把刚才 pop 出来的 autoKey 插回最前面。
  // 确保后面一定是 [key, init] 这样的顺序。
  if (typeof args[0] !== 'string') { args.unshift(autoKey) }

  // 解构得到：
  // _key: 状态的唯一名字
  // init: 初始化函数（可以返回值，也可以返回一个 Ref）
  const [_key, init] = args as [string, (() => T | Ref<T>)]

  // 校验 key 必须是字符串。
  // 如果没有或者类型错了，直接抛错。
  if (!_key || typeof _key !== 'string') {
    throw new TypeError('[nuxt] [useState] key must be a string: ' + _key)
  }

  // 校验 init 必须是一个函数。
  // Nuxt 强制这样写是为了保持一致的懒加载行为：
  // 避免每次组件 setup 执行都直接计算 init 的值，只有真正需要时才执行。
  if (init !== undefined && typeof init !== 'function') {
    throw new Error('[nuxt] [useState] init must be a function: ' + init)
  }

  // 把传入的 key 加上 Nuxt 内部固定的前缀（通常是 '$s_'），
  // 确保不会和其他 payload 字段冲突。
  const key = useStateKeyPrefix + _key

  // 获取当前 Nuxt app 实例。
  // 需要访问 nuxtApp.payload.state 来保存状态。
  const nuxtApp = useNuxtApp()
  const state = toRef(nuxtApp.payload.state, key)

  // 如果当前这个 key 在 payload.state 里面还没有值，
  // 并且提供了 init 初始化函数，
  // 那就执行 init，初始化一次！
  if (state.value === undefined && init) {
    // 调用 init 函数，拿到初始值。
    const initialValue = init()
    // 如果 init 返回的是一个 Ref：
    // 直接把这个 Ref 保存到 payload.state，返回它。
    // Vue 会自动解包 Ref，不需要你手动 unwrap。
    if (isRef(initialValue)) {
      // vue will unwrap the ref for us
      nuxtApp.payload.state[key] = initialValue
      return initialValue as Ref<T>
    }
    // 如果不是 Ref（比如是普通对象、字符串、数组等），
    // 就直接赋值到 state.value，完成初始化。
    state.value = initialValue
  }
  //最后返回这个 state（Ref<T>）。
  // 以后在组件或者 composable 里，就可以直接 state.value 读写了。
  return state
}

/** @since 3.6.0 */
// 用来清理 Nuxt 应用中 useState 保存的状态的。
export function clearNuxtState (
  keys?: string | string[] | ((key: string) => boolean),
): void {
  // 获取当前的 Nuxt 应用实例。
  // 里面有 nuxtApp.payload.state，保存了所有 useState 产生的状态数据。
  const nuxtApp = useNuxtApp()
  // 拿到所有状态的 key 列表。
  // 注意这里做了 .substring(useStateKeyPrefix.length)：
  // useState 保存到 payload.state 时，前面加了一个统一的前缀（通常是 '$s_'）。
  // 这里把前缀去掉，只保留原始 key 名。
  //
  // 例如：
  // 真正存在 payload.state['$s_counter']
  // 这里取出来的是 'counter'
  const _allKeys = Object.keys(nuxtApp.payload.state)
    .map(key => key.substring(useStateKeyPrefix.length))

  // 确定最终要清除哪些 key。
  // 逻辑：
  // 如果没有传 keys，就默认清除全部 key。
  // 如果传了函数（过滤器），就用 .filter(keys) 挑选。
  // 如果传了单个字符串或者数组，统一用 toArray 转成数组。
  const _keys: string[] = !keys
    ? _allKeys
    : typeof keys === 'function'
      ? _allKeys.filter(keys)
      : toArray(keys)

  // 遍历每一个要清除的 key。
  // 重要！：需要重新加回 useStateKeyPrefix 前缀，才能正确访问 payload.state 里面的真实 key。
  for (const _key of _keys) {
    const key = useStateKeyPrefix + _key
    if (key in nuxtApp.payload.state) {
      nuxtApp.payload.state[key] = undefined
    }
  }
}
