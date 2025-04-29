import { reactive } from 'vue'
import { klona } from 'klona'
import type { AppConfig } from 'nuxt/schema'
import { useNuxtApp } from './nuxt'
// @ts-expect-error virtual file
// 引入由 Nuxt 编译器在构建时生成的 app.config 虚拟模块。
// 里面是用户在 app.config.ts 中写的内容。
// 虽然是 virtual file，但编译后实际存在于 .nuxt 中。
import __appConfig from '#build/app.config.mjs'

// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
// 用来做 updateAppConfig 的参数类型支持，允许递归性地部分更新对象的任意嵌套字段。
// 核心是 Partial<T> 的深度版本。
type DeepPartial<T> = T extends Function ? T : T extends Record<string, any> ? { [P in keyof T]?: DeepPartial<T[P]> } : T

// Workaround for vite HMR with virtual modules
// 供 HMR 热更新调用，返回原始 __appConfig。
// 会被 import.meta.hot.accept() 或 webpack HMR 使用。
export const _getAppConfig = () => __appConfig as AppConfig

// 判断一个值是否是「纯对象」或数组。
// 用于后面 deepAssign / deepDelete 的递归处理。
function isPojoOrArray (val: unknown): val is object {
  return (
    Array.isArray(val) ||
    (!!val &&
      typeof val === 'object' &&
      val.constructor?.name === 'Object')
  )
}

// 深度删除 obj 中 newObj 没有的字段。
// 保证 config 更新后不会保留旧字段。
function deepDelete (obj: any, newObj: any) {
  for (const key in obj) {
    const val = newObj[key]
    if (!(key in newObj)) {
      delete (obj as any)[key]
    }

    if (isPojoOrArray(val)) {
      deepDelete(obj[key], newObj[key])
    }
  }
}

// 核心逻辑：深度合并对象字段。
// 支持嵌套、自动初始化空对象或数组。
// 如果 val 是对象或数组，递归处理；否则直接赋值。
function deepAssign (obj: any, newObj: any) {
  for (const key in newObj) {
    if (key === '__proto__' || key === 'constructor') { continue }
    const val = newObj[key]
    if (isPojoOrArray(val)) {
      const defaultVal = Array.isArray(val) ? [] : {}
      obj[key] ||= defaultVal
      deepAssign(obj[key], val)
    } else {
      obj[key] = val
    }
  }
}

// 条件	      行为
// server 端	使用 klona 深拷贝一份 appConfig（避免跨请求共享）
// client 端	使用 Vue reactive() 包一层响应式 AppConfig
export function useAppConfig (): AppConfig {
  const nuxtApp = useNuxtApp()
  nuxtApp._appConfig ||= (import.meta.server ? klona(__appConfig) : reactive(__appConfig)) as AppConfig
  return nuxtApp._appConfig
}

// 整替换 AppConfig，用于内部 HMR。
// 用 deepAssign 合并，用 deepDelete 清理旧字段。
export function _replaceAppConfig (newConfig: AppConfig) {
  const appConfig = useAppConfig()

  deepAssign(appConfig, newConfig)
  deepDelete(appConfig, newConfig)
}

/**
 * Deep assign the current appConfig with the new one.
 *
 * Will preserve existing properties.
 */
// 用户可调用的更新方法。
// 只做合并（不做删除），适合非破坏性更新。
export function updateAppConfig (appConfig: DeepPartial<AppConfig>) {
  const _appConfig = useAppConfig()
  deepAssign(_appConfig, appConfig)
}

// HMR Support
if (import.meta.dev) {
  const applyHMR = (newConfig: AppConfig) => {
    const appConfig = useAppConfig()
    if (newConfig && appConfig) {
      deepAssign(appConfig, newConfig)
      deepDelete(appConfig, newConfig)
    }
  }

  // Vite
  if (import.meta.hot) {
    // 接受新的模块，获取 _getAppConfig()，用 deepAssign + deepDelete 应用。
    import.meta.hot.accept((newModule) => {
      const newConfig = newModule?._getAppConfig()
      applyHMR(newConfig)
    })
  }

  // webpack
  // 监听虚拟模块 #build/app.config.mjs 变更，重新加载。
  if (import.meta.webpackHot) {
    import.meta.webpackHot.accept('#build/app.config.mjs', () => {
      applyHMR(__appConfig)
    })
  }
}
