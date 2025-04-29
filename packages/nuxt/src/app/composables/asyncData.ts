import { computed, getCurrentInstance, getCurrentScope, onBeforeMount, onScopeDispose, onServerPrefetch, onUnmounted, ref, shallowRef, toRef, unref, watch } from 'vue'
import type { MultiWatchSources, Ref } from 'vue'


// 【用户调用 useAsyncData(handler, options)】
//         ↓
// 【标准化参数】→ 整理成 key, handler, options
//         ↓
// 【校验参数】→ key 必须是 string, handler 必须是 function
//         ↓
// 【拿 nuxtApp 实例】
//         ↓
// 【处理 handler 包装】→
//     - SSR prerender？加 shared cache
//     - 否则直接 handler
//         ↓
// 【补齐 options 默认值】→
//     - server, lazy, immediate, deep, dedupe
//         ↓
// 【从缓存恢复数据（payload/static）】
//         ↓
// 【初始化 asyncData 对象】
//     - data, pending, error, status
//         ↓
// 【清理内部字段（_default）】
//         ↓
// 【绑定 refresh/execute 方法】
//         ↓
// 【绑定 clear 方法】
//         ↓
// 【如果 import.meta.server】
//     【服务器端执行】
//       - immediate: true？→ serverPrefetch + promise
//         ↓
// 【如果 import.meta.client】
//     【客户端执行】
//       - hydration 阶段？→ 不 fetch 或挂载前 fetch
//       - lazy: true？→ onBeforeMount fetch
//       - immediate: true？→ 直接 fetch
//         ↓
//     【处理 dedupe 去重】
//     【设置 watch 自动刷新】
//     【监听 app:data:refresh 统一刷新】
//         ↓
// 【返回一个可以 await 的 asyncDataPromise】

// TODO: temporary module for backwards compatibility
import type { DedupeOption, DefaultAsyncDataErrorValue, DefaultAsyncDataValue } from 'nuxt/app/defaults'

import { captureStackTrace } from 'errx'
import type { NuxtApp } from '../nuxt'
import { useNuxtApp } from '../nuxt'
import { toArray } from '../utils'
import type { NuxtError } from './error'
import { createError } from './error'
import { onNuxtReady } from './ready'

// @ts-expect-error virtual file
import { asyncDataDefaults, resetAsyncDataToUndefined } from '#build/nuxt.config.mjs'

export type AsyncDataRequestStatus = 'idle' | 'pending' | 'success' | 'error'

export type _Transform<Input = any, Output = any> = (input: Input) => Output | Promise<Output>

export type PickFrom<T, K extends Array<string>> = T extends Array<any>
  ? T
  : T extends Record<string, any>
    ? keyof T extends K[number]
      ? T // Exact same keys as the target, skip Pick
      : K[number] extends never
        ? T
        : Pick<T, K[number]>
    : T

export type KeysOf<T> = Array<
  T extends T // Include all keys of union types, not just common keys
    ? keyof T extends string
      ? keyof T
      : never
    : never
>

export type KeyOfRes<Transform extends _Transform> = KeysOf<ReturnType<Transform>>

export type { MultiWatchSources }

export type NoInfer<T> = [T][T extends any ? 0 : never]

export interface AsyncDataOptions<
  ResT,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> {
  /**
   * Whether to fetch on the server side.
   * @default true
   */
  server?: boolean
  /**
   * Whether to resolve the async function after loading the route, instead of blocking client-side navigation
   * @default false
   */
  lazy?: boolean
  /**
   * a factory function to set the default value of the data, before the async function resolves - useful with the `lazy: true` or `immediate: false` options
   */
  default?: () => DefaultT | Ref<DefaultT>
  /**
   * Provide a function which returns cached data.
   * An `undefined` return value will trigger a fetch.
   * Default is `key => nuxt.isHydrating ? nuxt.payload.data[key] : nuxt.static.data[key]` which only caches data when payloadExtraction is enabled.
   */
  getCachedData?: (key: string, nuxtApp: NuxtApp) => NoInfer<DataT> | undefined
  /**
   * A function that can be used to alter handler function result after resolving.
   * Do not use it along with the `pick` option.
   */
  transform?: _Transform<ResT, DataT>
  /**
   * Only pick specified keys in this array from the handler function result.
   * Do not use it along with the `transform` option.
   */
  pick?: PickKeys
  /**
   * Watch reactive sources to auto-refresh when changed
   */
  watch?: MultiWatchSources
  /**
   * When set to false, will prevent the request from firing immediately
   * @default true
   */
  immediate?: boolean
  /**
   * Return data in a deep ref object (it is true by default). It can be set to false to return data in a shallow ref object, which can improve performance if your data does not need to be deeply reactive.
   */
  deep?: boolean
  /**
   * Avoid fetching the same key more than once at a time
   * @default 'cancel'
   */
  dedupe?: 'cancel' | 'defer'
}

export interface AsyncDataExecuteOptions {
  _initial?: boolean
  /**
   * Force a refresh, even if there is already a pending request. Previous requests will
   * not be cancelled, but their result will not affect the data/pending state - and any
   * previously awaited promises will not resolve until this new request resolves.
   *
   * Instead of using `boolean` values, use `cancel` for `true` and `defer` for `false`.
   * Boolean values will be removed in a future release.
   */
  dedupe?: DedupeOption
}

export interface _AsyncData<DataT, ErrorT> {
  data: Ref<DataT>
  /**
   * @deprecated Use `status` instead. This may be removed in a future major version.
   */
  pending: Ref<boolean>
  refresh: (opts?: AsyncDataExecuteOptions) => Promise<void>
  execute: (opts?: AsyncDataExecuteOptions) => Promise<void>
  clear: () => void
  error: Ref<ErrorT | DefaultAsyncDataErrorValue>
  status: Ref<AsyncDataRequestStatus>
}

export type AsyncData<Data, Error> = _AsyncData<Data, Error> & Promise<_AsyncData<Data, Error>>

// TODO: remove boolean option in Nuxt 4
const isDefer = (dedupe?: boolean | 'cancel' | 'defer') => dedupe === 'defer' || dedupe === false

/**
 * Provides access to data that resolves asynchronously in an SSR-friendly composable.
 * See {@link https://nuxt.com/docs/api/composables/use-async-data}
 * @since 3.0.0
 * @param handler An asynchronous function that must return a truthy value (for example, it should not be `undefined` or `null`) or the request may be duplicated on the client side.
 * @param options customize the behavior of useAsyncData
 */
export function useAsyncData<
  ResT,
  NuxtErrorDataT = unknown,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>) | DefaultAsyncDataErrorValue>
/**
 * Provides access to data that resolves asynchronously in an SSR-friendly composable.
 * See {@link https://nuxt.com/docs/api/composables/use-async-data}
 * @param handler An asynchronous function that must return a truthy value (for example, it should not be `undefined` or `null`) or the request may be duplicated on the client side.
 * @param options customize the behavior of useAsyncData
 */
export function useAsyncData<
  ResT,
  NuxtErrorDataT = unknown,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
> (
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>) | DefaultAsyncDataErrorValue>
/**
 * Provides access to data that resolves asynchronously in an SSR-friendly composable.
 * See {@link https://nuxt.com/docs/api/composables/use-async-data}
 * @param key A unique key to ensure that data fetching can be properly de-duplicated across requests.
 * @param handler An asynchronous function that must return a truthy value (for example, it should not be `undefined` or `null`) or the request may be duplicated on the client side.
 * @param options customize the behavior of useAsyncData
 */
export function useAsyncData<
  ResT,
  NuxtErrorDataT = unknown,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  key: string,
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>) | DefaultAsyncDataErrorValue>
/**
 * Provides access to data that resolves asynchronously in an SSR-friendly composable.
 * See {@link https://nuxt.com/docs/api/composables/use-async-data}
 * @param key A unique key to ensure that data fetching can be properly de-duplicated across requests.
 * @param handler An asynchronous function that must return a truthy value (for example, it should not be `undefined` or `null`) or the request may be duplicated on the client side.
 * @param options customize the behavior of useAsyncData
 */
export function useAsyncData<
  ResT,
  NuxtErrorDataT = unknown,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
> (
  key: string,
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>) | DefaultAsyncDataErrorValue>


// ResT 是接口返回值
// DataT 是你真正想用的数据结构
// PickKeys 是从 DataT 挑选的字段
// DefaultT 是默认值类型
// 最后返回的是一个 AsyncData 对象（带有 data、pending、error、refresh 方法）。
export function useAsyncData<
  ResT,
  NuxtErrorDataT = unknown,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (...args: any[]): AsyncData<PickFrom<DataT, PickKeys>, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>) | DefaultAsyncDataErrorValue> {
  // 如果最后一个参数是字符串（key），就弹出来。
  // 如果第一个参数不是字符串（没有手动给 key），就把自动推测的 autoKey 插到最前面。
  // 目的： 保证后续总是 [key, handler, options] 的格式。
  const autoKey = typeof args[args.length - 1] === 'string' ? args.pop() : undefined
  if (typeof args[0] !== 'string') { args.unshift(autoKey) }

  // eslint-disable-next-line prefer-const
  // 解构标准化后的 args，拿到：
  // key: asyncData 的缓存 key。
  // _handler: 真正去拿数据的函数。
  // options: 选项配置，比如 lazy、server-only 等。
  let [key, _handler, options = {}] = args as [string, (ctx?: NuxtApp) => Promise<ResT>, AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>]

  // Validate arguments
  // 检查 key 必须是字符串，不然报错
  // 检查 handler 必须是函数，不然报错。
  // 目的： 保证 API 使用正确。
  if (typeof key !== 'string') {
    throw new TypeError('[nuxt] [asyncData] key must be a string.')
  }
  if (typeof _handler !== 'function') {
    throw new TypeError('[nuxt] [asyncData] handler must be a function.')
  }

  // Setup nuxt instance payload
  // 拿到当前 Nuxt 应用实例。
  const nuxtApp = useNuxtApp()

  // When prerendering, share payload data automatically between requests
  // 如果是客户端(import.meta.client)，或者不是预渲染(!import.meta.prerender)，或者没有 _sharedPrerenderCache，
  // 直接用用户提供的 _handler。
  // 否则（在预渲染时服务器端执行），要用一个加了缓存的 handler：
  // 如果 key 已经有缓存的 Promise，直接返回。
  // 如果没有，运行 _handler，然后把 Promise 存到 _sharedPrerenderCache。
  // 目的： 在预渲染过程中，相同数据请求只跑一次，避免浪费和重复执行。
  const handler = import.meta.client || !import.meta.prerender || !nuxtApp.ssrContext?._sharedPrerenderCache
    ? _handler
    : () => {
        const value = nuxtApp.ssrContext!._sharedPrerenderCache!.get(key)
        if (value) { return value as Promise<ResT> }

        const promise = Promise.resolve().then(() => nuxtApp.runWithContext(_handler))

        nuxtApp.ssrContext!._sharedPrerenderCache!.set(key, promise)
        return promise
      }

  // Used to get default values
  // 提供一个函数 getDefault，返回默认的 asyncData 空值（通常是 undefined 或 {}）。
  const getDefault = () => asyncDataDefaults.value
  // 定义一个函数 getDefaultCachedData：
  // 如果当前在客户端的 hydration 阶段（页面初始化），
  // 取 payload.data[key]（服务器渲染注入到客户端的初始数据）。
  // 否则（比如纯静态模式），取 static.data[key]。
  // 目的： 支持从已有缓存里恢复 asyncData，而不是重新请求。
  const getDefaultCachedData = () => nuxtApp.isHydrating ? nuxtApp.payload.data[key] : nuxtApp.static.data[key]

  // Apply defaults
  // options.server 如果用户没填，默认是 true。
  // 表示：在服务器端也会执行这个 asyncData
  // 如果设置成 false，那 asyncData 只在客户端触发。
  options.server ??= true
  // options.default 如果没有提供，
  // 用刚才定义的 getDefault() 函数作为默认值提供者
  // getDefault() 返回一般是 {} 或 undefined。
  options.default ??= getDefault as () => DefaultT
  // options.getCachedData 默认用 getDefaultCachedData。
  // 这个函数：
  // Hydration 阶段取 payload
  // 静态模式取 static
  // 不是直接重新请求。
  options.getCachedData ??= getDefaultCachedData

  // options.lazy 默认是 false。
  // lazy = false 表示 asyncData 会在组件挂载前立即开始加载。
  options.lazy ??= false
  // options.immediate 默认是 true。
  // immediate = true 表示 asyncData 初始化就马上触发请求。
  // 如果你希望手动调用 refresh() 才触发，可以设 immediate: false。
  options.immediate ??= true
  // options.deep 默认用 Nuxt 配置的 asyncDataDefaults.deep。
  // 通常 deep = true。
  // 决定是用 ref()（深响应式）还是 shallowRef()（浅响应式）来存 data。
  options.deep ??= asyncDataDefaults.deep
  // options.dedupe 默认是 'cancel'。
  // 意思是如果有重复的 asyncData 请求：
  // 'cancel'：取消上一个旧请求，发新请求。
  // 'defer'：继续等待旧请求，直到结果出来。
  // 如果写 boolean（比如 true/false），马上警告：
  options.dedupe ??= 'cancel'

  // 在开发环境，如果 dedupe 还用 boolean，
  // 控制台输出警告，提示要改成 'cancel' 或 'defer'。
  // 这是 Nuxt 未来兼容性调整的一部分。
  if (import.meta.dev && typeof options.dedupe === 'boolean') {
    console.warn('[nuxt] `boolean` values are deprecated for the `dedupe` option of `useAsyncData` and will be removed in the future. Use \'cancel\' or \'defer\' instead.')
  }

  // Create or use a shared asyncData entity
  // 调用 getCachedData 方法，看缓存里有没有已有的数据。
  // initialCachedData 是从 payload/static 拿到的数据。
  // hasCachedData = 是否拿到了有效数据。
  const initialCachedData = options.getCachedData!(key, nuxtApp)
  const hasCachedData = initialCachedData != null

  // 如果 key 对应的 asyncData 实体不存在，或者是 immediate: false，就新建一个。
  if (!nuxtApp._asyncData[key] || !options.immediate) {
    nuxtApp.payload._errors[key] ??= asyncDataDefaults.errorValue

    const _ref = options.deep ? ref : shallowRef
    nuxtApp._asyncData[key] = {
      data: _ref(hasCachedData ? initialCachedData : options.default!()),
      pending: ref(!hasCachedData),
      error: toRef(nuxtApp.payload._errors, key),
      status: ref('idle'),
      _default: options.default!,
    }
  }

  // TODO: Else, somehow check for conflicting keys with different defaults or fetcher
  // 这是一个开发者留的 TODO 注释，还没有做。
  // 意思是：
  // 如果 nuxtApp._asyncData[key] 已经存在，
  // 可能需要检查：
  // default 值是不是不一样？
  // fetcher（handler）是不是不一样？
  // 这样可以防止不同组件注册了同一个 key 但逻辑不一致，引发潜在冲突。
  // 目前这段逻辑是留空的，还没处理！

  // 把 nuxtApp._asyncData[key] 浅拷贝一份，赋值给 asyncData。
  // 这一步为什么要拷贝？
  // 因为内部用的 _default 字段是内部管理的，不希望直接暴露给用户。
  // 浅拷贝后可以删除内部私有字段。
  // 同时，做了强制类型断言：
  // 把 _default（内部字段）加进去
  // 也把外部看到的 AsyncData 类型合并进去。
  const asyncData = { ...nuxtApp._asyncData[key] } as { _default?: unknown } & AsyncData<DataT | DefaultT, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>)>

  // Don't expose default function to end user
  // 删除 asyncData 上的 _default 字段。
  // 防止用户看到或误用 _default。
  // asyncData 暴露出去的应该只有：
  // data
  // pending
  // error
  // status
  // refresh（后面会加）
  // 安全、干净地封装 asyncData 对象。
  delete asyncData._default

  // 真正执行异步请求
  // 管理 pending/loading 状态
  // 处理成功/失败结果
  // 支持请求去重 (dedupe)
  // 支持 lazy, transform, pick 等特性
  asyncData.refresh = asyncData.execute = (opts = {}) => {
    // 如果当前已经有一个同 key 的正在请求的 Promise：
    // 如果 dedupe 策略是 'defer'（推迟，等待旧请求完成），
    // 那就直接返回旧 promise。
    // 否则（比如 'cancel'），
    // 把旧的 Promise 打上 cancelled = true 标记，稍后不会更新数据。
    // 防止同时重复发多个一样的请求。
    if (nuxtApp._asyncDataPromises[key]) {
      if (isDefer(opts.dedupe ?? options.dedupe)) {
        // Avoid fetching same key more than once at a time
        return nuxtApp._asyncDataPromises[key]!
      }
      (nuxtApp._asyncDataPromises[key] as any).cancelled = true
    }
    // Avoid fetching same key that is already fetched
    // 如果是：
    // opts._initial = true（首次初始化）
    // 或者正在 hydration（客户端启动恢复阶段）
    // 那么：
    // 查一下缓存有没有值。
    // 如果有缓存，直接用缓存，不重新发请求。
    if ((opts._initial || (nuxtApp.isHydrating && opts._initial !== false))) {
      const cachedData = opts._initial ? initialCachedData : options.getCachedData!(key, nuxtApp)
      if (cachedData != null) {
        return Promise.resolve(cachedData)
      }
    }

    // 标记当前状态
    asyncData.pending.value = true
    asyncData.status.value = 'pending'
    // TODO: Cancel previous promise
    // 封装一个新的 Promise，执行 handler(nuxtApp)。
    // 注意这里包了一层 try/catch，防止 handler 内部直接抛异常。
    const promise = new Promise<ResT>(
      (resolve, reject) => {
        try {
          resolve(handler(nuxtApp))
        } catch (err) {
          reject(err)
        }
      })
      // 成功了以后，首先检查：
      // 如果这个 promise 已经被标记 cancelled，
      // 就忽略这个结果，返回新的 promise。
      .then(async (_result) => {
        // If this request is cancelled, resolve to the latest request.
        // 如果这个 promise 已经被标记 cancelled，
        // 就忽略这个结果，返回新的 promise。
        if ((promise as any).cancelled) { return nuxtApp._asyncDataPromises[key] }

        // 处理 transform 和 pick：
        // 如果用户配置了 transform，先对结果加工一遍。
        // 如果配置了 pick（只取某些字段），提取需要的字段。
        // 这些都是 asyncData 提供的灵活特性。
        let result = _result as unknown as DataT
        if (options.transform) {
          result = await options.transform(_result)
        }
        if (options.pick) {
          result = pick(result as any, options.pick) as DataT
        }

        // 如果在开发模式 + 服务器端，并且结果是 undefined，
        // 控制台警告：
        // asyncData 不应该返回 undefined！
        // 否则客户端可能会重新触发重复请求。
        if (import.meta.dev && import.meta.server && typeof result === 'undefined') {
          const stack = captureStackTrace()
          const { source, line, column } = stack[stack.length - 1] ?? {}
          const explanation = source ? ` (used at ${source.replace(/^file:\/\//, '')}:${line}:${column})` : ''
          // @ts-expect-error private property
          console.warn(`[nuxt] \`${options._functionName || 'useAsyncData'}${explanation}\` must return a value (it should not be \`undefined\`) or the request may be duplicated on the client side.`)
        }

        // 成功后：
        // 把 result 存到 payload.data 里（客户端 hydration 用）。
        // 更新响应式：
        // data = 结果
        // error = 无错误
        // status = 'success'
        nuxtApp.payload.data[key] = result

        asyncData.data.value = result
        asyncData.error.value = asyncDataDefaults.errorValue
        asyncData.status.value = 'success'
      })
      .catch((error: any) => {
        // 失败了以后：
        // 把错误封装成 Nuxt 的标准 Error。
        // 把 data 恢复成默认值。
        // status = 'error'
        // If this request is cancelled, resolve to the latest request.
        if ((promise as any).cancelled) { return nuxtApp._asyncDataPromises[key] }

        asyncData.error.value = createError<NuxtErrorDataT>(error) as (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>)
        asyncData.data.value = unref(options.default!())
        asyncData.status.value = 'error'
      })
      .finally(() => {
        // 最后，无论成功/失败：
        // 如果 promise 没有 cancelled，
        // 标记 pending = false
        // 清理 nuxtApp._asyncDataPromises[key]，防止内存泄漏。
        if ((promise as any).cancelled) { return }

        asyncData.pending.value = false

        delete nuxtApp._asyncDataPromises[key]
      })
    nuxtApp._asyncDataPromises[key] = promise
    return nuxtApp._asyncDataPromises[key]!
  }

  // 给 asyncData 对象挂上 clear() 方法。
  // 调用它可以清理掉对应 key 的 asyncData 缓存、状态、错误。
  asyncData.clear = () => clearNuxtDataByKey(nuxtApp, key)

  // 封装一个 initialFetch() 方法，专门用于首次加载 asyncData
  // 里面就是调用 refresh()，并且传 _initial: true（代表初始化）。
  const initialFetch = () => asyncData.refresh({ _initial: true })

  // 如果 options.server !== false（允许服务器端加载）
  // 并且页面是服务器渲染生成的 (serverRendered)，
  // 那么 fetchOnServer = true。
  // 决定是否要在服务器端跑 asyncData。
  const fetchOnServer = options.server !== false && nuxtApp.payload.serverRendered

  // Server side
  // 如果当前是服务器端，并且允许 fetch，并且是 immediate，就进行服务器端加载。
  if (import.meta.server && fetchOnServer && options.immediate) {
    // 如果有当前组件实例（getCurrentInstance()）：
    // 注册到 onServerPrefetch。
    // 这样可以在服务器渲染时自动等待 asyncData 加载完成。
    // 否则（比如插件里）：
    // 在 app:created 时候手动 await promise。
    const promise = initialFetch()
    if (getCurrentInstance()) {
      onServerPrefetch(() => promise)
    } else {
      nuxtApp.hook('app:created', async () => { await promise })
    }
  }

  // Client side
  // 如果是客户端环境
  if (import.meta.client) {
    // Setup hook callbacks once per instance
    // 拿当前组件实例。
    const instance = getCurrentInstance()

    // @ts-expect-error - instance.sp is an internal vue property
    // 强制 Vue 标记这个组件为异步组件（Async Boundary）。
    // 防止 hydration mismatch（比如 useId 错乱）。
    // 这个 instance.sp 是 Vue 内部隐藏字段。
    if (instance && fetchOnServer && options.immediate && !instance.sp) {
      // @ts-expect-error - internal vue property. This force vue to mark the component as async boundary client-side to avoid useId hydration issue since we treeshake onServerPrefetch
      instance.sp = []
    }

    // 如果页面不是 hydration，而且组件已经挂载了，还调用 useAsyncData，
    // 控制台发出警告：
    // 这时候应该用 $fetch() 而不是 useAsyncData()！
    if (import.meta.dev && !nuxtApp.isHydrating && !nuxtApp._processingMiddleware /* internal flag */ && (!instance || instance?.isMounted)) {
      // @ts-expect-error private property
      console.warn(`[nuxt] [${options._functionName || 'useAsyncData'}] Component is already mounted, please use $fetch instead. See https://nuxt.com/docs/getting-started/data-fetching`)
    }

    // 如果当前实例还没注册挂载回调数组 _nuxtOnBeforeMountCbs
    // 就新建一个。
    if (instance && !instance._nuxtOnBeforeMountCbs) {
      instance._nuxtOnBeforeMountCbs = []
      const cbs = instance._nuxtOnBeforeMountCbs
      // 在组件挂载前，执行收集到的回调。
      // 卸载时清空回调数组。
      onBeforeMount(() => {
        cbs.forEach((cb) => { cb() })
        cbs.splice(0, cbs.length)
      })
      onUnmounted(() => cbs.splice(0, cbs.length))
    }

    // 第一次 hydration 阶段，如果已经有错误或缓存数据：
    // 就不重新 fetch 了。
    // 直接根据 error/缓存设置 pending=false，status 成功/失败。
    if (fetchOnServer && nuxtApp.isHydrating && (asyncData.error.value || initialCachedData != null)) {
      // 1. Hydration (server: true): no fetch
      asyncData.pending.value = false
      asyncData.status.value = asyncData.error.value ? 'error' : 'success'
    } else if (instance && ((nuxtApp.payload.serverRendered && nuxtApp.isHydrating) || options.lazy) && options.immediate) {
      // 如果：
      // 服务器渲染但正在 hydration，或者
      // lazy 加载模式，
      // 那么把 initialFetch 推到组件挂载前（onBeforeMount）再执行。
      // 2. Initial load (server: false): fetch on mounted
      // 3. Initial load or navigation (lazy: true): fetch on mounted
      instance._nuxtOnBeforeMountCbs.push(initialFetch)
    } else if (options.immediate) {
      // 否则（正常的 CSR 渲染/页面跳转）并且 immediate，就直接立刻调用 initialFetch()。
      // 4. Navigation (lazy: false) - or plugin usage: await fetch
      initialFetch()
    }

    // 如果配置了 watch（比如 watch: () => route.path），
    // 那么设置一个 watcher，变化时自动 refresh()。
    // 如果当前有 Vue 的 effectScope，在销毁时解除 watch。
    const hasScope = getCurrentScope()
    if (options.watch) {
      const unsub = watch(options.watch, () => asyncData.refresh())
      if (hasScope) {
        onScopeDispose(unsub)
      }
    }

    // 监听 app:data:refresh 事件。
    // 这个事件可以让外部统一触发 asyncData 重新请求，比如点击 "刷新所有数据"。
    const off = nuxtApp.hook('app:data:refresh', async (keys) => {
      if (!keys || keys.includes(key)) {
        await asyncData.refresh()
      }
    })
    if (hasScope) {
      onScopeDispose(off)
    }
  }

  // Allow directly awaiting on asyncData
  // 把 asyncData 包装成一个 Promise。
  const asyncDataPromise = Promise.resolve(nuxtApp._asyncDataPromises[key]).then(() => asyncData) as AsyncData<ResT, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>)>
  Object.assign(asyncDataPromise, asyncData)

  return asyncDataPromise as AsyncData<PickFrom<DataT, PickKeys>, (NuxtErrorDataT extends Error | NuxtError ? NuxtErrorDataT : NuxtError<NuxtErrorDataT>)>
}
/** @since 3.0.0 */
export function useLazyAsyncData<
  ResT,
  DataE = Error,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: Omit<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'lazy'>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, DataE | DefaultAsyncDataValue>
export function useLazyAsyncData<
  ResT,
  DataE = Error,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
> (
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: Omit<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'lazy'>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, DataE | DefaultAsyncDataValue>
export function useLazyAsyncData<
  ResT,
  DataE = Error,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  key: string,
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: Omit<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'lazy'>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, DataE | DefaultAsyncDataValue>
export function useLazyAsyncData<
  ResT,
  DataE = Error,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
> (
  key: string,
  handler: (ctx?: NuxtApp) => Promise<ResT>,
  options?: Omit<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'lazy'>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, DataE | DefaultAsyncDataValue>

// ResT: 后端返回的原始响应类型。
// DataE: 异步请求失败时的错误类型，默认是 Error。
// DataT: 经过处理后的数据类型，默认跟 ResT 一样。
// PickKeys: 想要从 DataT 中选取的字段 key。
// DefaultT: 默认值的类型，默认是 DefaultAsyncDataValue。
export function useLazyAsyncData<
  ResT,
  DataE = Error,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (...args: any[]): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, DataE | DefaultAsyncDataValue> {
  // 看最后一个参数是不是 string 类型（通常是 key）。
  // 如果是，就从 args 中 pop() 出来，保存成 autoKey。
  // 否则 autoKey 就是 undefined。
  // 目的： 兼容用户少写 key 的情况，自动推断 key。
  const autoKey = typeof args[args.length - 1] === 'string' ? args.pop() : undefined
  // 如果第一个参数不是字符串（说明用户没有主动传 key），
  // 那么把 autoKey 插回到 args 最前面。
  // 保证 args 现在是 [key, handler, options] 格式。
  if (typeof args[0] !== 'string') { args.unshift(autoKey) }
  // 正式解构出：
  // key: 数据缓存用的名字。
  // handler: 用来加载异步数据的函数 (ctx?: NuxtApp) => Promise<ResT>。
  // options: 额外选项，比如 server/client only、默认值、pick keys 等等。
  const [key, handler, options = {}] = args as [string, (ctx?: NuxtApp) => Promise<ResT>, AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>]

  // 如果当前是开发环境，并且是客户端，
  // 给 options 打一个内部私有标记 _functionName = 'useLazyAsyncData'。
  // 目的： 帮助调试 asyncData 源头（比如开发工具里显示是哪个 useAsyncData 调用的）。
  // （@ts-expect-error 是因为 _functionName 并不是标准定义的属性，只是内部用）
  if (import.meta.dev && import.meta.client) {
    // @ts-expect-error private property
    options._functionName ||= 'useLazyAsyncData'
  }

  // @ts-expect-error we pass an extra argument to prevent a key being injected
  // key：缓存名字
  // handler：请求函数
  // { ...options, lazy: true }：传入 options，同时强制加上 lazy: true。
  // lazy: true = 懒加载模式（页面渲染时不马上请求，等真正需要的时候再请求）。
  // null：第四个参数用来控制注入行为，这里传 null 表示不要注入额外的 key（避免出错）。
  return useAsyncData(key, handler, { ...options, lazy: true }, null)
}

/** @since 3.1.0 */
// 接受一个参数 key（string），表示要访问的 asyncData 对应的名字。
// 返回一个对象 { data: Ref<DataT | DefaultAsyncDataValue> }：
// data 是一个 Vue 3 的 Ref（响应式的引用）。
// DataT 是泛型，默认是 any，你可以自己指定数据类型。
export function useNuxtData<DataT = any> (key: string): { data: Ref<DataT | DefaultAsyncDataValue> } {
  const nuxtApp = useNuxtApp()

  // Initialize value when key is not already set
  if (!(key in nuxtApp.payload.data)) {
    nuxtApp.payload.data[key] = asyncDataDefaults.value
  }

  return {
    data: computed({
      get () {
        return nuxtApp._asyncData[key]?.data.value ?? nuxtApp.payload.data[key]
      },
      set (value) {
        if (nuxtApp._asyncData[key]) {
          nuxtApp._asyncData[key]!.data.value = value
        } else {
          nuxtApp.payload.data[key] = value
        }
      },
    }),
  }
}

/** @since 3.0.0 */
export async function refreshNuxtData (keys?: string | string[]): Promise<void> {
  if (import.meta.server) {
    return Promise.resolve()
  }

  await new Promise<void>(resolve => onNuxtReady(resolve))

  const _keys = keys ? toArray(keys) : undefined
  await useNuxtApp().hooks.callHookParallel('app:data:refresh', _keys)
}

/** @since 3.0.0 */
// 输入参数 keys 是可选的，类型可以是：
// 一个 string（单个 key 名字），或者
// 一个 string[]（多个 key 名字的数组），或者
// 一个 函数 (key) => boolean（用于过滤要清除的 key）。
// 返回值是 void，表示没有返回值，只是执行清理操作。
export function clearNuxtData (keys?: string | string[] | ((key: string) => boolean)): void {
  // 调用 useNuxtApp() 获取到当前的 Nuxt 应用实例。
  // 里面包含 payload（初始数据）、asyncData 缓存等等。
  const nuxtApp = useNuxtApp()
  // 获取当前 payload.data（也就是页面中所有已经加载过的 asyncData）的所有 key 列表。
  // _allKeys 是一个数组，比如：['user', 'posts', 'settings']。
  const _allKeys = Object.keys(nuxtApp.payload.data)
  // 如果用户没有传入任何 keys 参数
  // 那么默认清除所有 key（_keys = _allKeys）
  const _keys: string[] = !keys
    ? _allKeys
    : typeof keys === 'function'
      ? _allKeys.filter(keys)
      : toArray(keys)

  for (const key of _keys) {
    clearNuxtDataByKey(nuxtApp, key)
  }
}

// 从 nuxtApp 中，把指定 key 相关的 异步数据（AsyncData）缓存清除掉。
// nuxtApp: 当前的 Nuxt 应用实例。
// key: 要清除的 asyncData 的 key 名字。
function clearNuxtDataByKey (nuxtApp: NuxtApp, key: string): void {
  // 检查 key 是否存在于 nuxtApp.payload.data 里（页面的数据部分）。
  // 如果存在，把对应的数据置为 undefined，清空数据。
  if (key in nuxtApp.payload.data) {
    nuxtApp.payload.data[key] = undefined
  }

  // 检查 key 是否存在于 nuxtApp.payload._errors（数据请求时可能产生的错误记录）。
  // 如果有，把错误重置成默认的错误值 asyncDataDefaults.errorValue（通常是 null 或 undefined）。
  if (key in nuxtApp.payload._errors) {
    nuxtApp.payload._errors[key] = asyncDataDefaults.errorValue
  }

  // 如果在 nuxtApp._asyncData（存放 useAsyncData 的数据容器）里有对应的 key，
  // 继续对内部的 data、error、pending、status 做清除或重置。
  if (nuxtApp._asyncData[key]) {
    // 如果 resetAsyncDataToUndefined 是 true（全局配置），那就直接清成 undefined。
    // 否则就恢复成原本定义 asyncData 时的默认值 _default()。
    // 注意：这里用 unref() 是因为默认值可能是 ref() 包装过的。
    nuxtApp._asyncData[key]!.data.value = resetAsyncDataToUndefined ? undefined : unref(nuxtApp._asyncData[key]!._default())
    // error 重置
    // pending（是否在加载中）设置为 false
    // status（加载状态）改成 'idle'（空闲中）
    // 完整地清除掉 asyncData 相关状态。
    nuxtApp._asyncData[key]!.error.value = asyncDataDefaults.errorValue
    nuxtApp._asyncData[key]!.pending.value = false
    nuxtApp._asyncData[key]!.status.value = 'idle'
  }

  // 再检查 key 是否存在于 nuxtApp._asyncDataPromises。
  // 这里是正在进行的异步请求 Promise。
  if (key in nuxtApp._asyncDataPromises) {
    if (nuxtApp._asyncDataPromises[key]) {
      // 如果当前 key 对应的 Promise 存在，
      // 给它打上一个 cancelled = true 的标记，告诉系统这个请求已经被取消了。
      (nuxtApp._asyncDataPromises[key] as any).cancelled = true
    }

    // 最后，把这个 Promise 也置为 undefined，彻底清理。
    nuxtApp._asyncDataPromises[key] = undefined
  }
}

// 从一个对象里，挑出指定 keys，形成一个新的对象
function pick (obj: Record<string, any>, keys: string[]) {
  const newObj = {}
  for (const key of keys) {
    (newObj as any)[key] = obj[key]
  }
  return newObj
}
