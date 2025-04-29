import { isReactive, isRef, isShallow, toRaw } from 'vue'
import { definePayloadReducer } from '../composables/payload'
import { isNuxtError } from '../composables/error'
import { defineNuxtPlugin } from '../nuxt'

// @ts-expect-error Virtual file.
import { componentIslands } from '#build/nuxt.config.mjs'

// 在服务端 SSR / SSG 时，把 Nuxt 应用中复杂的响应式对象（ref, reactive, error, island 等）序列化成可以安全传输到客户端的结构。

const reducers: [string, (data: any) => any][] = [
  // 如果是 NuxtError 对象，
  // 调用 .toJSON() 方法安全地转换成普通 JSON。
  ['NuxtError', data => isNuxtError(data) && data.toJSON()],
  // 空的 shallowRef，序列化特殊标志。
  // 注意 BigInt 需要转成 '0n' 字符串（JSON 不支持 BigInt）。
  ['EmptyShallowRef', data => isRef(data) && isShallow(data) && !data.value && (typeof data.value === 'bigint' ? '0n' : (JSON.stringify(data.value) || '_'))],
  // 空的普通 ref，类似处理。
  ['EmptyRef', data => isRef(data) && !data.value && (typeof data.value === 'bigint' ? '0n' : (JSON.stringify(data.value) || '_'))],
  // 非空的 shallowRef，直接拿 data.value。
  ['ShallowRef', data => isRef(data) && isShallow(data) && data.value],
  // 浅响应式对象 shallowReactive，使用 toRaw() 提取原始数据。
  ['ShallowReactive', data => isReactive(data) && isShallow(data) && toRaw(data)],
  // 普通的 ref，直接拿 .value。
  ['Ref', data => isRef(data) && data.value],
  // 深层的 reactive，也用 toRaw() 抹掉 Proxy 包装。
  ['Reactive', data => isReactive(data) && toRaw(data)],
]

// 如果启用了 Nuxt 的 Islands 架构，
// 需要额外处理 Island 组件的数据。
// 特别提取 __nuxt_island 字段，序列化 island 信息。
if (componentIslands) {
  reducers.push(['Island', data => data && data?.__nuxt_island])
}

export default defineNuxtPlugin({
  name: 'nuxt:revive-payload:server',
  setup () {
    for (const [reducer, fn] of reducers) {
      definePayloadReducer(reducer, fn)
    }
  },
})
