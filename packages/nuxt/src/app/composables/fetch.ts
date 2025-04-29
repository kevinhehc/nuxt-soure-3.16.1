import type { FetchError, FetchOptions } from 'ofetch'
import type { $Fetch, H3Event$Fetch, NitroFetchRequest, TypedInternalResponse, AvailableRouterMethod as _AvailableRouterMethod } from 'nitropack'
import type { MaybeRef, Ref } from 'vue'
import { computed, reactive, toValue } from 'vue'
import { hash } from 'ohash'

// TODO: temporary module for backwards compatibility
import type { DefaultAsyncDataErrorValue, DefaultAsyncDataValue } from 'nuxt/app/defaults'

import { useRequestFetch } from './ssr'
import type { AsyncData, AsyncDataOptions, KeysOf, MultiWatchSources, PickFrom } from './asyncData'
import { useAsyncData } from './asyncData'

// @ts-expect-error virtual file
import { fetchDefaults } from '#build/nuxt.config.mjs'

// support uppercase methods, detail: https://github.com/nuxt/nuxt/issues/22313
type AvailableRouterMethod<R extends NitroFetchRequest> = _AvailableRouterMethod<R> | Uppercase<_AvailableRouterMethod<R>>

export type FetchResult<ReqT extends NitroFetchRequest, M extends AvailableRouterMethod<ReqT>> = TypedInternalResponse<ReqT, unknown, Lowercase<M>>

type ComputedOptions<T extends Record<string, any>> = {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  [K in keyof T]: T[K] extends Function ? T[K] : ComputedOptions<T[K]> | Ref<T[K]> | T[K]
}

interface NitroFetchOptions<R extends NitroFetchRequest, M extends AvailableRouterMethod<R> = AvailableRouterMethod<R>> extends FetchOptions {
  method?: M
}

type ComputedFetchOptions<R extends NitroFetchRequest, M extends AvailableRouterMethod<R>> = ComputedOptions<NitroFetchOptions<R, M>>

export interface UseFetchOptions<
  ResT,
  DataT = ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
  R extends NitroFetchRequest = string & {},
  M extends AvailableRouterMethod<R> = AvailableRouterMethod<R>,
> extends Omit<AsyncDataOptions<ResT, DataT, PickKeys, DefaultT>, 'watch'>, ComputedFetchOptions<R, M> {
  key?: string
  $fetch?: typeof globalThis.$fetch
  watch?: MultiWatchSources | false
}

/**
 * Fetch data from an API endpoint with an SSR-friendly composable.
 * See {@link https://nuxt.com/docs/api/composables/use-fetch}
 * @since 3.0.0
 * @param request The URL to fetch
 * @param opts extends $fetch options and useAsyncData options
 */
export function useFetch<
  ResT = void,
  ErrorT = FetchError,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void ? 'get' extends AvailableRouterMethod<ReqT> ? 'get' : AvailableRouterMethod<ReqT> : AvailableRouterMethod<ReqT>,
  _ResT = ResT extends void ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  request: Ref<ReqT> | ReqT | (() => ReqT),
  opts?: UseFetchOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, ErrorT | DefaultAsyncDataErrorValue>
/**
 * Fetch data from an API endpoint with an SSR-friendly composable.
 * See {@link https://nuxt.com/docs/api/composables/use-fetch}
 * @param request The URL to fetch
 * @param opts extends $fetch options and useAsyncData options
 */
export function useFetch<
  ResT = void,
  ErrorT = FetchError,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void ? 'get' extends AvailableRouterMethod<ReqT> ? 'get' : AvailableRouterMethod<ReqT> : AvailableRouterMethod<ReqT>,
  _ResT = ResT extends void ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
> (
  request: Ref<ReqT> | ReqT | (() => ReqT),
  opts?: UseFetchOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, ErrorT | DefaultAsyncDataErrorValue>




export function useFetch<
  ResT = void, // 最终返回的数据类型
  ErrorT = FetchError, // 错误类型
  ReqT extends NitroFetchRequest = NitroFetchRequest,  // 请求体类型
  Method extends AvailableRouterMethod<ReqT> = ResT extends void ? 'get' extends AvailableRouterMethod<ReqT> ? 'get' : AvailableRouterMethod<ReqT> : AvailableRouterMethod<ReqT>,
  _ResT = ResT extends void ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
  // 复杂的泛型定义，自动推导：
  // 请求 (request)
  // 响应 (ResT)
  // 请求方法 (get/post/put...)
  // 异常 (ErrorT)
> (
  // 请求地址（或 Ref/函数包裹）
  request: Ref<ReqT> | ReqT | (() => ReqT),
  // key 或 options
  arg1?: string | UseFetchOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>,
  // 是 key（如果 arg1 是 options）
  arg2?: string,
) {
  // 把参数分解成 options 和 key。
  const [opts = {}, autoKey] = typeof arg1 === 'string' ? [{}, arg1] : [arg1, arg2]

  // 请求参数标准化成 computed，确保是响应式的。
  const _request = computed(() => toValue(request))

  // 自动生成唯一的 asyncData key。
  // 根据：
  // autoKey
  // request path
  // options 内容 组合 hash 出 key。
  // 避免 key 冲突。
  const _key = opts.key || hash([autoKey, typeof _request.value === 'string' ? _request.value : '', ...generateOptionSegments(opts)])
  if (!_key || typeof _key !== 'string') {
    throw new TypeError('[nuxt] [useFetch] key must be a string: ' + _key)
  }
  if (!request) {
    throw new Error('[nuxt] [useFetch] request is missing.')
  }

  // 如果是 autoKey，手动加上 $f 前缀区分。
  const key = _key === autoKey ? '$f' + _key : _key

  // 确保 request 存在且格式正确。
  if (!opts.baseURL && typeof _request.value === 'string' && (_request.value[0] === '/' && _request.value[1] === '/')) {
    throw new Error('[nuxt] [useFetch] the request URL must not start with "//".')
  }

  // 拆出专属于 asyncData 的选项。
  // 剩下的是发给 $fetch 的选项。
  const {
    server,
    lazy,
    default: defaultFn,
    transform,
    pick,
    watch,
    immediate,
    getCachedData,
    deep,
    dedupe,
    ...fetchOptions
  } = opts

  // 默认值合并。
  // 如果 cache: boolean，要清理掉不支持的字段。
  const _fetchOptions = reactive({
    ...fetchDefaults,
    ...fetchOptions,
    cache: typeof opts.cache === 'boolean' ? undefined : opts.cache,
  })

  // 转交给 useAsyncData 的配置对象。
  // 比如 lazy, immediate, deep, dedupe, watch 等。
  // 让 useFetch 和 useAsyncData 的特性无缝结合。
  const _asyncDataOptions: AsyncDataOptions<_ResT, DataT, PickKeys, DefaultT> = {
    server,
    lazy,
    default: defaultFn,
    transform,
    pick,
    immediate,
    getCachedData,
    deep,
    dedupe,
    watch: watch === false ? [] : [_fetchOptions, _request, ...(watch || [])],
  }

  if (import.meta.dev && import.meta.server) {
    // @ts-expect-error private property
    _asyncDataOptions._functionName = opts._functionName || 'useFetch'
  }

  // 支持请求 abort（取消旧请求）。
  let controller: AbortController

  // 真正的数据加载逻辑交给 useAsyncData。
  // 回调返回一个 Promise。
  const asyncData = useAsyncData<_ResT, ErrorT, DataT, PickKeys, DefaultT>(key, () => {
    // 如果上次还没结束的请求存在，abort 掉。
    // 创建新的 abort controller。
    controller?.abort?.(new DOMException('Request aborted as another request to the same endpoint was initiated.', 'AbortError'))
    controller = typeof AbortController !== 'undefined' ? new AbortController() : {} as AbortController

    /**
     * Workaround for `timeout` not working due to custom abort controller
     * TODO: remove this when upstream issue is resolved
     * @see https://github.com/unjs/ofetch/issues/326
     * @see https://github.com/unjs/ofetch/blob/bb2d72baa5d3f332a2185c20fc04e35d2c3e258d/src/fetch.ts#L152
     */
    // 手动模拟 fetch timeout（因为 ofetch 原生 timeout 有问题）。
    const timeoutLength = toValue(opts.timeout)
    let timeoutId: NodeJS.Timeout
    if (timeoutLength) {
      timeoutId = setTimeout(() => controller.abort(new DOMException('Request aborted due to timeout.', 'AbortError')), timeoutLength)
      controller.signal.onabort = () => clearTimeout(timeoutId)
    }

    // 优先用传入的 $fetch。
    // 如果在服务端，并且访问本地 API，使用带 server context 的 useRequestFetch()。
    let _$fetch: H3Event$Fetch | $Fetch<unknown, NitroFetchRequest> = opts.$fetch || globalThis.$fetch

    // Use fetch with request context and headers for server direct API calls
    if (import.meta.server && !opts.$fetch) {
      const isLocalFetch = typeof _request.value === 'string' && _request.value[0] === '/' && (!toValue(opts.baseURL) || toValue(opts.baseURL)![0] === '/')
      if (isLocalFetch) {
        _$fetch = useRequestFetch()
      }
    }

    // 发起请求。
    // 成功/失败都要清除 timeout 定时器。
    return _$fetch(_request.value, { signal: controller.signal, ..._fetchOptions } as any).finally(() => { clearTimeout(timeoutId) }) as Promise<_ResT>
  }, _asyncDataOptions)

  return asyncData
}

/** @since 3.0.0 */
export function useLazyFetch<
  ResT = void,
  ErrorT = FetchError,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void ? 'get' extends AvailableRouterMethod<ReqT> ? 'get' : AvailableRouterMethod<ReqT> : AvailableRouterMethod<ReqT>,
  _ResT = ResT extends void ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  request: Ref<ReqT> | ReqT | (() => ReqT),
  opts?: Omit<UseFetchOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>, 'lazy'>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, ErrorT | DefaultAsyncDataErrorValue>
export function useLazyFetch<
  ResT = void,
  ErrorT = FetchError,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void ? 'get' extends AvailableRouterMethod<ReqT> ? 'get' : AvailableRouterMethod<ReqT> : AvailableRouterMethod<ReqT>,
  _ResT = ResT extends void ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DataT,
> (
  request: Ref<ReqT> | ReqT | (() => ReqT),
  opts?: Omit<UseFetchOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>, 'lazy'>
): AsyncData<PickFrom<DataT, PickKeys> | DefaultT, ErrorT | DefaultAsyncDataErrorValue>
export function useLazyFetch<
  ResT = void,
  ErrorT = FetchError,
  ReqT extends NitroFetchRequest = NitroFetchRequest,
  Method extends AvailableRouterMethod<ReqT> = ResT extends void ? 'get' extends AvailableRouterMethod<ReqT> ? 'get' : AvailableRouterMethod<ReqT> : AvailableRouterMethod<ReqT>,
  _ResT = ResT extends void ? FetchResult<ReqT, Method> : ResT,
  DataT = _ResT,
  PickKeys extends KeysOf<DataT> = KeysOf<DataT>,
  DefaultT = DefaultAsyncDataValue,
> (
  request: Ref<ReqT> | ReqT | (() => ReqT),
  arg1?: string | Omit<UseFetchOptions<_ResT, DataT, PickKeys, DefaultT, ReqT, Method>, 'lazy'>,
  arg2?: string,
) {
  const [opts = {}, autoKey] = typeof arg1 === 'string' ? [{}, arg1] : [arg1, arg2]

  if (import.meta.dev && import.meta.server) {
    // @ts-expect-error private property
    opts._functionName ||= 'useLazyFetch'
  }

  return useFetch<ResT, ErrorT, ReqT, Method, _ResT, DataT, PickKeys, DefaultT>(request, {
    ...opts,
    lazy: true,
  },
  // @ts-expect-error we pass an extra argument with the resolved auto-key to prevent another from being injected
  autoKey)
}

// 根据 useFetch 传入的 options 生成一组 hash 段（segments），用于参与生成 asyncData key，确保缓存命中准确。
function generateOptionSegments<_ResT, DataT, DefaultT> (opts: UseFetchOptions<_ResT, DataT, any, DefaultT, any, any>) {

  // 新建一个数组 segments。
  const segments: Array<string | undefined | Record<string, string>> = [
    // 都使用 toValue()，支持 Ref 包裹的情况（响应式解包）。
    // 这样即使 method 和 baseURL 是 ref()，也能正常取值。

    // HTTP 方法（比如 'GET'、'POST'），默认是 'GET'。
    toValue(opts.method as MaybeRef<string | undefined> | undefined)?.toUpperCase() || 'GET',
    // Base URL（比如 'https://api.example.com'）。
    toValue(opts.baseURL),
  ]
  // 遍历请求参数（params/query）
  for (const _obj of [opts.params || opts.query]) {
    // opts.params
    // opts.query
    // 只取一个，优先 params，其次 query。

    // 如果没有提供，则跳过。
    const obj = toValue(_obj)
    if (!obj) { continue }

    // 把 params 里的每个 key-value 对也都 toValue()。
    // 确保即使是 ref() 包裹的 key 或 value，也能解出来。
    // 最后生成一个普通的、未响应式的 { [key: value] } 字典。
    // 这步是防止 hash 的时候因为 ref 对象而出 bug。
    const unwrapped: Record<string, string> = {}
    for (const [key, value] of Object.entries(obj)) {
      unwrapped[toValue(key)] = toValue(value)
    }

    // 把处理好的 params 作为一整个对象加入 segments 列表。
    segments.push(unwrapped)
  }
  return segments

  // 举个完整例子
  // 比如调用：
  // useFetch('/api/posts', {
  //   method: 'post',
  //   baseURL: 'https://api.example.com',
  //   params: { userId: 123 }
  // })

  // generateOptionSegments(opts) 最后返回：

  // [
  //   'POST',                    // 方法
  //   'https://api.example.com',  // baseURL
  //   { userId: '123' }           // params
  // ]

  // 然后 useFetch 会拿这几个 segment 去做 hash()，得到唯一的 key，比如：
  // f893dab6 // 这是异步数据缓存的 key
  // 保证 不同 method, baseURL, params 的请求，不会混淆到同一个缓存！
}
