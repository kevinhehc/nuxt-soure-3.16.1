import type { Configuration as WebpackConfig, WebpackPluginInstance } from 'webpack'
import type { RspackPluginInstance } from '@rspack/core'
import type { UserConfig as ViteConfig, Plugin as VitePlugin } from 'vite'
import { useNuxt } from './context'
import { toArray } from './utils'

// 动态修改和扩展 Vite、Webpack、Rspack 配置的统一工具函数。
//
// 主要用于：
//
// 动态给构建工具（Vite/Webpack/Rspack）添加插件
//
// 动态修改 client/server 的构建配置
//
// 在模块开发时优雅地扩展构建器行为

export interface ExtendConfigOptions {
  /**
   * Install plugin on dev
   * @default true
   */
  dev?: boolean
  /**
   * Install plugin on build
   * @default true
   */
  build?: boolean
  /**
   * Install plugin on server side
   * @default true
   */
  server?: boolean
  /**
   * Install plugin on client side
   * @default true
   */
  client?: boolean
  /**
   * Prepends the plugin to the array with `unshift()` instead of `push()`.
   */
  prepend?: boolean
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtendWebpackConfigOptions extends ExtendConfigOptions {}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ExtendViteConfigOptions extends ExtendConfigOptions {}

const extendWebpackCompatibleConfig = (builder: 'rspack' | 'webpack') => (fn: ((config: WebpackConfig) => void), options: ExtendWebpackConfigOptions = {}) => {
  const nuxt = useNuxt()

  if (options.dev === false && nuxt.options.dev) {
    return
  }
  if (options.build === false && nuxt.options.build) {
    return
  }

  nuxt.hook(`${builder}:config`, (configs) => {
    if (options.server !== false) {
      const config = configs.find(i => i.name === 'server')
      if (config) {
        fn(config)
      }
    }
    if (options.client !== false) {
      const config = configs.find(i => i.name === 'client')
      if (config) {
        fn(config)
      }
    }
  })
}

/**
 * Extend webpack config
 *
 * The fallback function might be called multiple times
 * when applying to both client and server builds.
 */
export const extendWebpackConfig = extendWebpackCompatibleConfig('webpack')
/**
 * Extend rspack config
 *
 * The fallback function might be called multiple times
 * when applying to both client and server builds.
 */
export const extendRspackConfig = extendWebpackCompatibleConfig('rspack')

/**
 * Extend Vite config
 */
export function extendViteConfig (fn: ((config: ViteConfig) => void), options: ExtendViteConfigOptions = {}) {
  const nuxt = useNuxt()

  if (options.dev === false && nuxt.options.dev) {
    return
  }
  if (options.build === false && nuxt.options.build) {
    return
  }

  if (options.server !== false && options.client !== false) {
    // Call fn() only once
    return nuxt.hook('vite:extend', ({ config }) => fn(config))
  }

  nuxt.hook('vite:extendConfig', (config, { isClient, isServer }) => {
    if (options.server !== false && isServer) {
      return fn(config)
    }
    if (options.client !== false && isClient) {
      return fn(config)
    }
  })
}

/**
 * Append webpack plugin to the config.
 */
export function addWebpackPlugin (pluginOrGetter: WebpackPluginInstance | WebpackPluginInstance[] | (() => WebpackPluginInstance | WebpackPluginInstance[]), options?: ExtendWebpackConfigOptions) {
  extendWebpackConfig((config) => {
    const method: 'push' | 'unshift' = options?.prepend ? 'unshift' : 'push'
    const plugin = typeof pluginOrGetter === 'function' ? pluginOrGetter() : pluginOrGetter

    config.plugins ||= []
    config.plugins[method](...toArray(plugin))
  }, options)
}
/**
 * Append rspack plugin to the config.
 */
export function addRspackPlugin (pluginOrGetter: RspackPluginInstance | RspackPluginInstance[] | (() => RspackPluginInstance | RspackPluginInstance[]), options?: ExtendWebpackConfigOptions) {
  extendRspackConfig((config) => {
    const method: 'push' | 'unshift' = options?.prepend ? 'unshift' : 'push'
    const plugin = typeof pluginOrGetter === 'function' ? pluginOrGetter() : pluginOrGetter

    config.plugins ||= []
    config.plugins[method](...toArray(plugin))
  }, options)
}

/**
 * Append Vite plugin to the config.
 */
export function addVitePlugin (pluginOrGetter: VitePlugin | VitePlugin[] | (() => VitePlugin | VitePlugin[]), options?: ExtendViteConfigOptions) {
  extendViteConfig((config) => {
    const method: 'push' | 'unshift' = options?.prepend ? 'unshift' : 'push'
    const plugin = typeof pluginOrGetter === 'function' ? pluginOrGetter() : pluginOrGetter

    config.plugins ||= []
    config.plugins[method](...toArray(plugin))
  }, options)
}

interface AddBuildPluginFactory {
  vite?: () => VitePlugin | VitePlugin[]
  webpack?: () => WebpackPluginInstance | WebpackPluginInstance[]
  rspack?: () => RspackPluginInstance | RspackPluginInstance[]
}

export function addBuildPlugin (pluginFactory: AddBuildPluginFactory, options?: ExtendConfigOptions) {
  if (pluginFactory.vite) {
    addVitePlugin(pluginFactory.vite, options)
  }

  if (pluginFactory.webpack) {
    addWebpackPlugin(pluginFactory.webpack, options)
  }

  if (pluginFactory.rspack) {
    addRspackPlugin(pluginFactory.rspack, options)
  }
}
