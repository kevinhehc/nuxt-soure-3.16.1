import process from 'node:process'
import destr from 'destr'
import { snakeCase } from 'scule'
import { klona } from 'klona'

import defu from 'defu'
import { useNuxt } from './context'
import { useNitro } from './nitro'

// 用于访问和动态更新 Nuxt 的 Runtime Config（运行时配置）的方法集合，并支持环境变量覆盖与动态扩展。
//
// 主要负责：
//
// 读取最终生效的 runtimeConfig
//
// 支持从 process.env 动态覆盖配置
//
// 支持字符串中的环境变量动态展开（env expansion）
//
// 提供更新 runtimeConfig 的方法


/**
 * Access 'resolved' Nuxt runtime configuration, with values updated from environment.
 *
 * This mirrors the runtime behavior of Nitro.
 */
export function useRuntimeConfig () {
  const nuxt = useNuxt()
  return applyEnv(klona(nuxt.options.nitro.runtimeConfig!), {
    prefix: 'NITRO_',
    altPrefix: 'NUXT_',
    envExpansion: nuxt.options.nitro.experimental?.envExpansion ?? !!process.env.NITRO_ENV_EXPANSION,
  })
}

/**
 * Update Nuxt runtime configuration.
 */
export function updateRuntimeConfig (runtimeConfig: Record<string, unknown>) {
  const nuxt = useNuxt()
  Object.assign(nuxt.options.nitro.runtimeConfig as Record<string, unknown>, defu(runtimeConfig, nuxt.options.nitro.runtimeConfig))

  try {
    return useNitro().updateConfig({ runtimeConfig })
  } catch {
    // Nitro is not yet initialised - we can safely ignore this error
  }
}

/**
 * https://github.com/nitrojs/nitro/blob/v2/src/runtime/internal/utils.env.ts.
*
 * These utils will be replaced by util exposed from nitropack. See https://github.com/nitrojs/nitro/pull/2404
 * for more context and future plans.)
 *
 * @internal
 */

type EnvOptions = {
  prefix?: string
  altPrefix?: string
  envExpansion?: boolean
}

function getEnv (key: string, opts: EnvOptions, env = process.env) {
  const envKey = snakeCase(key).toUpperCase()
  return destr(
    env[opts.prefix + envKey] ?? env[opts.altPrefix + envKey],
  )
}

function _isObject (input: unknown) {
  return typeof input === 'object' && !Array.isArray(input)
}

function applyEnv (
  obj: Record<string, any>,
  opts: EnvOptions,
  parentKey = '',
) {
  for (const key in obj) {
    const subKey = parentKey ? `${parentKey}_${key}` : key
    const envValue = getEnv(subKey, opts)
    if (_isObject(obj[key])) {
      // Same as before
      if (_isObject(envValue)) {
        obj[key] = { ...(obj[key] as any), ...(envValue as any) }
        applyEnv(obj[key], opts, subKey)
      } else if (envValue === undefined) {
        // If envValue is undefined
        // Then proceed to nested properties
        applyEnv(obj[key], opts, subKey)
      } else {
        // If envValue is a primitive other than undefined
        // Then set objValue and ignore the nested properties
        obj[key] = envValue ?? obj[key]
      }
    } else {
      obj[key] = envValue ?? obj[key]
    }
    // Experimental env expansion
    if (opts.envExpansion && typeof obj[key] === 'string') {
      obj[key] = _expandFromEnv(obj[key])
    }
  }
  return obj
}

const envExpandRx = /\{\{(.*?)\}\}/g

function _expandFromEnv (value: string, env: Record<string, any> = process.env) {
  return value.replace(envExpandRx, (match, key) => {
    return env[key] || match
  })
}
