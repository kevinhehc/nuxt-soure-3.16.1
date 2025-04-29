import { getCurrentInstance, reactive, toRefs } from 'vue'
import type { DefineComponent, defineComponent } from 'vue'
import { hash } from 'ohash'
import type { NuxtApp } from '../nuxt'
import { getNuxtAppCtx, useNuxtApp } from '../nuxt'
import { useHead } from './head'
import { useAsyncData } from './asyncData'
import { useRoute } from './router'
import { createError } from './error'

//  给每个经过 defineNuxtComponent 包装过的组件打一个标记：__nuxt_component = true。
// **用途：**后续在运行时可以识别哪些组件是 Nuxt 组件，而不是普通 Vue 组件。
export const NuxtComponentIndicator = '__nuxt_component'

/* @__NO_SIDE_EFFECTS__ */
// 给当前组件生成一个 fetchKey。
// 结合：
//    组件基础 key
//    当前路由 path + query
//    当前组件在路由 matched 中的索引
// 经过 hash() 得到唯一字符串。
// 作用：
// 用来区分不同页面/不同参数/同一个组件，不同 fetch。
function getFetchKey () {
  const vm = getCurrentInstance()!
  const route = useRoute()
  const { _fetchKeyBase } = vm.proxy!.$options
  return hash([
    _fetchKeyBase,
    route.path,
    route.query,
    route.matched.findIndex(r => Object.values(r.components || {}).includes(vm.type)),
  ])
}

// res：传入的是组件 setup 的返回对象（空对象或已有 setup 返回的 Promise）
// fn：就是组件 options.asyncData 封装成的异步函数

// 传入 setup 返回对象 res 和 asyncData 函数 fn
//       ↓
// 获取 fetchKey，生成 asyncData 缓存 key
//       ↓
// 调用 useAsyncData 统一管理异步请求、缓存、pending、error
//       ↓
// 如果出错，抛出 NuxtError
//       ↓
// 如果成功，把 asyncData 返回值变成 reactive+toRefs，并且合并进 res
async function runLegacyAsyncData (res: Record<string, any> | Promise<Record<string, any>>, fn: (nuxtApp: NuxtApp) => Promise<Record<string, any>>) {
  // 获取当前 Nuxt 应用实例。
  const nuxtApp = useNuxtApp()
  // 从当前组件实例里取 fetchKey。
  // fetchKey 是什么？
  // 它可以是一个字符串
  // 也可以是一个函数 (defaultKeyGen) => key
  // 主要目的是让 asyncData 在同组件不同参数下可以拥有不同缓存 key。
  const { fetchKey } = getCurrentInstance()!.proxy!.$options
  // 如果 fetchKey 是函数，调用它生成 key；
  // 如果是字符串，直接用；
  // 如果都没有，fallback 到 getFetchKey() 自动生成。
  // 这样保证asyncData 都有唯一且合理的 key。
  const key = (typeof fetchKey === 'function' ? fetchKey(() => '') : fetchKey) || getFetchKey()
  // 调用 useAsyncData 来真正执行 asyncData 函数！
  // key 是 options:asyncdata:${key}，带 options:前缀，区分不同来源。
  // 如果是在服务器端（import.meta.server），
  //    用 nuxtApp.runWithContext 包一下，保证 context 正确。
  // 如果是客户端，直接执行 fn(nuxtApp)。
  // 这里统一了服务器和客户端 asyncData 执行方式。
  const { data, error } = await useAsyncData(`options:asyncdata:${key}`, () => import.meta.server ? nuxtApp.runWithContext(() => fn(nuxtApp)) : fn(nuxtApp))
  if (error.value) {
    // 如果 asyncData 执行出错了：
    // 把 error 抛出去（变成 NuxtError）。
    // 这样外层调用的地方可以正确捕获 error。
    throw createError(error.value)
  }
  if (data.value && typeof data.value === 'object') {
    // 如果 asyncData 返回的是对象（正常情况）：
    // 把它转换成 reactive 响应式对象
    // 然后用 toRefs()，确保每个字段都是 ref
    // 再用 Object.assign 把这些字段合并进 res 里面。
    // 为什么用 toRefs？
    // 保持 asyncData 返回的字段都是响应式的。
    // 这样组件模板里直接可以用 data.xxx，自动响应式更新。
    Object.assign(await res, toRefs(reactive(data.value)))
  } else if (import.meta.dev) {
    // 如果 asyncData 返回的不是对象（比如返回了 null、数组、字符串等）：
    // 在开发模式下，给出警告。
    // 标准要求 asyncData 必须返回对象！
    console.warn('[nuxt] asyncData should return an object', data)
  }
}

/** @since 3.0.0 */
/* @__NO_SIDE_EFFECTS__ */
// defineNuxtComponent 本质上是一个 Nuxt 特制版的 defineComponent。
// 扩展了：
// asyncData
// head
// fetchKey 自动处理
//
// 调用 defineNuxtComponent(options)
//     ↓
// 如果没有 setup/asyncData/head，直接返回
//     ↓
// 否则包装新的 options + setup
//     ↓
// 新的 setup:
//     - 调用原 setup()
//     - 执行 asyncData（用 useAsyncData 包）
//     - 执行 head
//     - 等待所有 Promise 完成
//     - 返回最终的 setup 响应式数据
export const defineNuxtComponent: typeof defineComponent =
  function defineNuxtComponent (...args: any[]): any {
    // options 是标准 Vue 组件的 options。
    // key 是 Nuxt 注入的 _fetchKeyBase，用于 asyncData 的 key 生成。
    const [options, key] = args
    const { setup } = options as DefineComponent

    // Avoid wrapping if no options api is used
    // 如果组件本身没有：
    // setup
    // asyncData
    // head
    // 说明它是一个纯静态组件，不需要 Nuxt 特殊处理。
    if (!setup && !options.asyncData && !options.head) {
      // 直接打上 __nuxt_component 标记，返回原 options。
      return {
        [NuxtComponentIndicator]: true,
        ...options,
      }
    }

    // 包装新的 options
    return {
      [NuxtComponentIndicator]: true,
      _fetchKeyBase: key,
      ...options,
      setup (props, ctx) {
        // 拿到 Nuxt app 实例。
        // 初始化 res，未来这里会装 setup 返回的东西。
        const nuxtApp = useNuxtApp()
        let res = {}

        // 果原来有 setup：
        // 包成 Promise，兼容同步/异步 setup。
        // 服务端（SSR）用 callAsync 包住执行，保证上下文正确。
        // 客户端直接 set 当前 appContext。
        // 结果赋值给 res。
        if (setup) {
          const fn = (): Promise<Record<string, any>> => Promise.resolve(setup(props, ctx)).then((r: any) => r || {})
          const nuxtAppCtx = getNuxtAppCtx(nuxtApp._id)
          if (import.meta.server) {
            res = nuxtAppCtx.callAsync(nuxtApp, fn)
          } else {
            nuxtAppCtx.set(nuxtApp)
            res = fn()
          }
        }

        // 如果组件声明了 asyncData，
        // 用 runLegacyAsyncData 去跑 asyncData，把得到的数据合并进 res。
        // 注意：这里会把 asyncData 包成 Promise 推进 promises 数组。
        const promises: Promise<any>[] = []
        if (options.asyncData) {
          // asyncData的触发时机?
          promises.push(runLegacyAsyncData(res, options.asyncData))
        }

        // 如果组件有 head（定义 SEO / meta 信息），
        // 调用 useHead 注册 head。
        // 支持 head 是函数（动态 head）或对象（静态 head）。
        if (options.head) {
          useHead(typeof options.head === 'function' ? () => options.head(nuxtApp) : options.head)
        }

        // 把 res Promise 化，保证兼容 sync/async setup。
        // 等所有 asyncData Promise 完成。
        // 返回完整 res。
        // 最后清空 promises 数组，避免内存泄漏。
        return Promise.resolve(res)
          .then(() => Promise.all(promises))
          .then(() => res)
          .finally(() => {
            promises.length = 0
          })
      },
    } as DefineComponent
  }
