import { reactive, ref, shallowReactive, shallowRef } from 'vue'
import destr from 'destr'
import { definePayloadReviver, getNuxtClientPayload } from '../composables/payload'
import { createError } from '../composables/error'
import { defineNuxtPlugin, useNuxtApp } from '../nuxt'

// @ts-expect-error Virtual file.
import { componentIslands } from '#build/nuxt.config.mjs'

// 把服务端注入到 HTML 中的原始 payload 数据，恢复成完整、带响应式的 Vue 实例（比如 ref, reactive, shallowRef）

// 定义一组 payload revivers。
// 每个 reviver 都是一个 [名字, 恢复函数] 的 pair。
// 用来恢复被序列化后的特殊 Vue 数据结构，比如：
// ref()
// shallowRef()
// reactive()
// shallowReactive()
// NuxtError
// 特别注意：EmptyRef、EmptyShallowRef 需要处理 "_"、"0n" 等特例。
// 让服务端序列化的数据，在客户端重新变成活的 Vue 响应式对象！
const revivers: [string, (data: any) => any][] = [
  ['NuxtError', data => createError(data)],
  ['EmptyShallowRef', data => shallowRef(data === '_' ? undefined : data === '0n' ? BigInt(0) : destr(data))],
  ['EmptyRef', data => ref(data === '_' ? undefined : data === '0n' ? BigInt(0) : destr(data))],
  ['ShallowRef', data => shallowRef(data)],
  ['ShallowReactive', data => shallowReactive(data)],
  ['Ref', data => ref(data)],
  ['Reactive', data => reactive(data)],
]

// 处理 "Island" 特殊情况（如果启用了 Islands 架构）
if (componentIslands) {
  // 如果启用了 Nuxt Islands 架构（局部组件独立 Hydration），
  // 添加一个 Island 类型的 reviver。
  revivers.push(['Island', ({ key, params, result }: any) => {
    const nuxtApp = useNuxtApp()
    // 如果不是在 Hydration 阶段，动态 fetch /__nuxt_island/${key}.json
    // 把返回的数据填到 nuxtApp.payload.data[key]
    if (!nuxtApp.isHydrating) {
      nuxtApp.payload.data[key] ||= $fetch(`/__nuxt_island/${key}.json`, {
        responseType: 'json',
        ...params ? { params } : {},
      }).then((r) => {
        nuxtApp.payload.data[key] = r
        return r
      })
    }
    // 否则返回 { html: '', ...result } 作为占位。
    return {
      html: '',
      ...result,
    }
  }])
}

export default defineNuxtPlugin({
  name: 'nuxt:revive-payload:client',
  // 优先级比较靠前（在大部分其他插件之前执行）。
  // 因为 payload 必须在组件挂载和 setup 之前恢复好！
  order: -30,
  async setup (nuxtApp) {
    // 遍历所有 revivers
    // 调用 definePayloadReviver() 注册到全局 Payload 解码系统中。
    for (const [reviver, fn] of revivers) {
      // 后面在反序列化 payload 时，自动识别字段类型，比如：
      // {
      //   "someKey": { "_reviver": "Ref", "v": "some-value" }
      // }
      // 会用对应的 reviver 规则还原成 ref('some-value')！
      definePayloadReviver(reviver, fn)
    }

    // 调用 getNuxtClientPayload() 取到客户端预注入的 payload（在 SSR 或生成的 HTML 里）
    // 并合并到 nuxtApp.payload 中。
    // 让客户端 Nuxt 应用能从预渲染的 payload 中恢复状态，无需重新 fetch！
    Object.assign(nuxtApp.payload, await nuxtApp.runWithContext(getNuxtClientPayload))
    // For backwards compatibility - TODO: remove later
    // 出于兼容目的，把恢复后的 payload 重新挂回 window.__NUXT__。
    // 便于老插件、旧模块或用户脚本访问。
    window.__NUXT__ = nuxtApp.payload
  },
})
