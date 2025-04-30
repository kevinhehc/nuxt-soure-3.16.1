import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import type { JSValue } from 'untyped'
import { applyDefaults } from 'untyped'
import type { ConfigLayer, ConfigLayerMeta, LoadConfigOptions } from 'c12'
// 用 c12 库从磁盘加载 nuxt.config.ts, .nuxtrc 等文件
import { loadConfig } from 'c12'
import type { NuxtConfig, NuxtOptions } from '@nuxt/schema'
import { globby } from 'globby'
import defu from 'defu'
import { basename, join, relative } from 'pathe'
import { resolveModuleURL } from 'exsolve'

import { directoryToURL } from '../internal/esm'

export interface LoadNuxtConfigOptions extends Omit<LoadConfigOptions<NuxtConfig>, 'overrides'> {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
  overrides?: Exclude<LoadConfigOptions<NuxtConfig>['overrides'], Promise<any> | Function>
}

// 加载、合并、规范化完整的 Nuxt 配置 (nuxt.config.ts)，包括多层 Layer 配置，返回最终的 NuxtOptions 对象。
// 步骤	                      做了什么
// 1. globby('layers/*')	    自动检测本地 layers/ 目录下的子文件夹，作为 Layer
// 2. loadConfig()	          用 c12 库从磁盘加载 nuxt.config.ts, .nuxtrc 等文件
// 3. 设定默认 rootDir, alias	如果没手动设定，推断合理的默认值
// 4. 处理 buildDir	          在 Nuxt 4 兼容模式下，自动切换到 node_modules/.cache/nuxt/.nuxt 作为构建目录
// 5. 加载配置 schema	        调用 loadNuxtSchema() 动态加载 @nuxt/schema 提供的配置校验规则
// 6. 遍历所有 Layer	          对每个 Layer 应用默认值、过滤无效 Layer、生成 alias、生成 layer meta 信息
// 7. 整理出最终 Layers 列表	  保存到 nuxtOptions._layers 供后续使用
// 8. 最后应用 schema 默认值	  返回标准化后的 NuxtOptions，供 Nuxt 内核继续用
export async function loadNuxtConfig (opts: LoadNuxtConfigOptions): Promise<NuxtOptions> {
  // Automatically detect and import layers from `~~/layers/` directory
  // 自动检测本地 layers/ 目录下的子文件夹，作为 Layer

  const localLayers = await globby('layers/*', { onlyDirectories: true, cwd: opts.cwd || process.cwd() })
  opts.overrides = defu(opts.overrides, { _extends: localLayers });

  (globalThis as any).defineNuxtConfig = (c: any) => c
  const { configFile, layers = [], cwd, config: nuxtConfig, meta } = await loadConfig<NuxtConfig>({
    name: 'nuxt',
    configFile: 'nuxt.config',
    rcFile: '.nuxtrc',
    extend: { extendKey: ['theme', 'extends', '_extends'] },
    dotenv: true,
    globalRc: true,
    ...opts,
  })
  delete (globalThis as any).defineNuxtConfig

  // Fill config
  nuxtConfig.rootDir ||= cwd
  nuxtConfig._nuxtConfigFile = configFile
  nuxtConfig._nuxtConfigFiles = [configFile]
  nuxtConfig.alias ||= {}

  if (meta?.name) {
    const alias = `#layers/${meta.name}`
    nuxtConfig.alias[alias] ||= nuxtConfig.rootDir
  }

  const defaultBuildDir = join(nuxtConfig.rootDir!, '.nuxt')
  if (!opts.overrides?._prepare && !nuxtConfig.dev && !nuxtConfig.buildDir && nuxtConfig.future?.compatibilityVersion === 4 && existsSync(defaultBuildDir)) {
    nuxtConfig.buildDir = join(nuxtConfig.rootDir!, 'node_modules/.cache/nuxt/.nuxt')
  }

  const NuxtConfigSchema = await loadNuxtSchema(nuxtConfig.rootDir || cwd || process.cwd())

  const layerSchemaKeys = ['future', 'srcDir', 'rootDir', 'serverDir', 'dir']
  const layerSchema = Object.create(null)
  for (const key of layerSchemaKeys) {
    if (key in NuxtConfigSchema) {
      layerSchema[key] = NuxtConfigSchema[key]
    }
  }

  const _layers: ConfigLayer<NuxtConfig, ConfigLayerMeta>[] = []
  const processedLayers = new Set<string>()
  for (const layer of layers) {
    // Resolve `rootDir` & `srcDir` of layers
    layer.config ||= {}
    layer.config.rootDir ??= layer.cwd!

    // Only process/resolve layers once
    if (processedLayers.has(layer.config.rootDir)) { continue }
    processedLayers.add(layer.config.rootDir)

    // Normalise layer directories
    layer.config = await applyDefaults(layerSchema, layer.config as NuxtConfig & Record<string, JSValue>) as unknown as NuxtConfig

    // Filter layers
    if (!layer.configFile || layer.configFile.endsWith('.nuxtrc')) { continue }

    // Add layer name for local layers
    if (layer.cwd && cwd && localLayers.includes(relative(cwd, layer.cwd))) {
      layer.meta ||= {}
      layer.meta.name ||= basename(layer.cwd)
    }

    // Add layer alias
    if (layer.meta?.name) {
      const alias = `#layers/${layer.meta.name}`
      nuxtConfig.alias[alias] ||= layer.config.rootDir || layer.cwd
    }
    _layers.push(layer)
  }
  // 1
  ;(nuxtConfig as any)._layers = _layers

  // Ensure at least one layer remains (without nuxt.config)
  if (!_layers.length) {
    _layers.push({
      cwd,
      config: {
        rootDir: cwd,
        srcDir: cwd,
      },
    })
  }

  // Resolve and apply defaults
  return await applyDefaults(NuxtConfigSchema, nuxtConfig as NuxtConfig & Record<string, JSValue>) as unknown as NuxtOptions
}

// 根据当前目录，尝试找到并动态导入 @nuxt/schema 包。
// 里面定义了 NuxtConfigSchema，告诉你哪些字段是合法配置、默认值是多少。
// 如果找不到 @nuxt/schema，会尝试找 nuxt 或 nuxt-nightly。
async function loadNuxtSchema (cwd: string) {
  const url = directoryToURL(cwd)
  const urls = [url]
  const nuxtPath = resolveModuleURL('nuxt', { try: true, from: url }) ?? resolveModuleURL('nuxt-nightly', { try: true, from: url })
  if (nuxtPath) {
    urls.unshift(pathToFileURL(nuxtPath))
  }
  const schemaPath = resolveModuleURL('@nuxt/schema', { try: true, from: urls }) ?? '@nuxt/schema'
  return await import(schemaPath).then(r => r.NuxtConfigSchema)
}
