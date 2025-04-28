import { promises as fsp } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { defu } from 'defu'
import { applyDefaults } from 'untyped'
import { dirname } from 'pathe'
import type { ModuleDefinition, ModuleOptions, ModuleSetupInstallResult, ModuleSetupReturn, Nuxt, NuxtModule, NuxtOptions, ResolvedModuleOptions, ResolvedNuxtTemplate } from '@nuxt/schema'
import { logger } from '../logger'
import { nuxtCtx, tryUseNuxt, useNuxt } from '../context'
import { checkNuxtCompatibility, isNuxt2 } from '../compatibility'
import { compileTemplate, templateUtils } from '../internal/template'

/**
 * Define a Nuxt module, automatically merging defaults with user provided options, installing
 * any hooks that are provided, and calling an optional setup function for full control.
 */
export function defineNuxtModule<TOptions extends ModuleOptions> (
  definition: ModuleDefinition<TOptions, Partial<TOptions>, false> | NuxtModule<TOptions, Partial<TOptions>, false>
): NuxtModule<TOptions, TOptions, false>

export function defineNuxtModule<TOptions extends ModuleOptions> (): {
  with: <TOptionsDefaults extends Partial<TOptions>> (
    definition: ModuleDefinition<TOptions, TOptionsDefaults, true> | NuxtModule<TOptions, TOptionsDefaults, true>
  ) => NuxtModule<TOptions, TOptionsDefaults, true>
}

export function defineNuxtModule<TOptions extends ModuleOptions> (
  definition?: ModuleDefinition<TOptions, Partial<TOptions>, false> | NuxtModule<TOptions, Partial<TOptions>, false>,
) {
  if (definition) {
    return _defineNuxtModule(definition)
  }

  return {
    with: <TOptionsDefaults extends Partial<TOptions>>(
      definition: ModuleDefinition<TOptions, TOptionsDefaults, true> | NuxtModule<TOptions, TOptionsDefaults, true>,
    ) => _defineNuxtModule(definition),
  }
}

// 当你用 defineNuxtModule() 注册一个模块时，Nuxt 会用 _defineNuxtModule() 来把你的模块包一层，
// 让它变得统一规范、兼容 Nuxt 2/3，同时还能支持动态选项解析、自动兼容性检查、性能监控等。
function _defineNuxtModule<
  TOptions extends ModuleOptions,
  TOptionsDefaults extends Partial<TOptions>,
  TWith extends boolean,
> (
  definition: ModuleDefinition<TOptions, TOptionsDefaults, TWith> | NuxtModule<TOptions, TOptionsDefaults, TWith>,
): NuxtModule<TOptions, TOptionsDefaults, TWith> {
  if (typeof definition === 'function') {
    return _defineNuxtModule<TOptions, TOptionsDefaults, TWith>({ setup: definition })
  }

  // Normalize definition and meta
  const module: ModuleDefinition<TOptions, TOptionsDefaults, TWith> & Required<Pick<ModuleDefinition<TOptions, TOptionsDefaults, TWith>, 'meta'>> = defu(definition, { meta: {} })

  module.meta.configKey ||= module.meta.name

  // Resolves module options from inline options, [configKey] in nuxt.config, defaults and schema
  async function getOptions (
    inlineOptions?: Partial<TOptions>,
    nuxt: Nuxt = useNuxt(),
  ): Promise<
      TWith extends true
        ? ResolvedModuleOptions<TOptions, TOptionsDefaults>
        : TOptions
    > {
    // 负责动态解析模块的最终选项。
    // 解析来源顺序是：
    // 用户直接传的 inlineOptions
    // nuxt.config.ts 里的模块配置（通过 configKey）
    // 模块自带的 defaults（可以是对象或者 async 函数）
    // 如果模块提供了 schema，会用 schema 校验并应用默认值。
    const nuxtConfigOptionsKey = module.meta.configKey || module.meta.name

    const nuxtConfigOptions: Partial<TOptions> = nuxtConfigOptionsKey && nuxtConfigOptionsKey in nuxt.options ? nuxt.options[<keyof NuxtOptions> nuxtConfigOptionsKey] : {}

    const optionsDefaults: TOptionsDefaults =
      module.defaults instanceof Function
        ? await module.defaults(nuxt)
        : module.defaults ?? <TOptionsDefaults> {}

    let options = defu(inlineOptions, nuxtConfigOptions, optionsDefaults)

    if (module.schema) {
      options = await applyDefaults(module.schema, options) as any
    }

    // @ts-expect-error ignore type mismatch when calling `defineNuxtModule` without `.with()`
    return Promise.resolve(options)
  }

  // Module format is always a simple function
  async function normalizedModule (this: any, inlineOptions: Partial<TOptions>, nuxt: Nuxt): Promise<ModuleSetupReturn> {
    // 避免重复安装（记录在 _requiredModules）
    // 检查模块兼容性（调用 checkNuxtCompatibility）
    // 兼容 Nuxt 2 的 hook 系统（调用 nuxt2Shims)
    // 调用 getOptions，拿到解析后的最终 options
    // 注册 module.hooks （如果有的话）
    // 调用 module.setup(options, nuxt)，执行模块逻辑
    // 测量 setup 执行耗时，如果太慢（>5秒）警告提示
    // 返回 setup 返回的内容，加上 timings 信息
    nuxt ||= tryUseNuxt() || this.nuxt /* invoked by nuxt 2 */

    // Avoid duplicate installs
    const uniqueKey = module.meta.name || module.meta.configKey
    if (uniqueKey) {
      nuxt.options._requiredModules ||= {}
      if (nuxt.options._requiredModules[uniqueKey]) {
        return false
      }
      nuxt.options._requiredModules[uniqueKey] = true
    }

    // Check compatibility constraints
    if (module.meta.compatibility) {
      const issues = await checkNuxtCompatibility(module.meta.compatibility, nuxt)
      if (issues.length) {
        logger.warn(`Module \`${module.meta.name}\` is disabled due to incompatibility issues:\n${issues.toString()}`)
        return
      }
    }

    // Prepare
    nuxt2Shims(nuxt)

    // Resolve module and options
    const _options = await getOptions(inlineOptions, nuxt)

    // Register hooks
    if (module.hooks) {
      nuxt.hooks.addHooks(module.hooks)
    }

    // Call setup
    const start = performance.now()
    const res = await module.setup?.call(null as any, _options, nuxt) ?? {}
    const perf = performance.now() - start
    const setupTime = Math.round((perf * 100)) / 100

    // Measure setup time
    if (setupTime > 5000 && uniqueKey !== '@nuxt/telemetry') {
      logger.warn(`Slow module \`${uniqueKey || '<no name>'}\` took \`${setupTime}ms\` to setup.`)
    } else if (nuxt.options.debug && nuxt.options.debug.modules) {
      logger.info(`Module \`${uniqueKey || '<no name>'}\` took \`${setupTime}ms\` to setup.`)
    }

    // Check if module is ignored
    if (res === false) { return false }

    // Return module install result
    return defu(res, <ModuleSetupInstallResult> {
      timings: {
        setup: setupTime,
      },
    })
  }

  // Define getters for options and meta
  // 返回模块的 meta 信息
  normalizedModule.getMeta = () => Promise.resolve(module.meta)
  // 返回解析模块配置选项的 Promise
  normalizedModule.getOptions = getOptions

  return <NuxtModule<TOptions, TOptionsDefaults, TWith>> normalizedModule
}

// -- Nuxt 2 compatibility shims --
// 果在 Nuxt 2 环境下运行：
// 把 nuxt.hooks 直接指向 nuxt 本身
// 注入 useNuxt() 上下文管理
// 支持虚拟模板 (getContents) 写入 .nuxt/ 目录
// 保证即使在 Nuxt 2 也能正常运行新的模块。
const NUXT2_SHIMS_KEY = '__nuxt2_shims_key__'
function nuxt2Shims (nuxt: Nuxt) {
  // Avoid duplicate install and only apply to Nuxt2
  if (!isNuxt2(nuxt) || nuxt[NUXT2_SHIMS_KEY as keyof Nuxt]) { return }
  nuxt[NUXT2_SHIMS_KEY as keyof Nuxt] = true

  // Allow using nuxt.hooks
  // @ts-expect-error Nuxt 2 extends hookable
  nuxt.hooks = nuxt

  // Allow using useNuxt()
  if (!nuxtCtx.tryUse()) {
    nuxtCtx.set(nuxt)
    nuxt.hook('close', () => nuxtCtx.unset())
  }

  // Support virtual templates with getContents() by writing them to .nuxt directory
  let virtualTemplates: ResolvedNuxtTemplate[]
  // @ts-expect-error Nuxt 2 hook
  nuxt.hook('builder:prepared', (_builder, buildOptions) => {
    virtualTemplates = buildOptions.templates.filter((t: any) => t.getContents)
    for (const template of virtualTemplates) {
      buildOptions.templates.splice(buildOptions.templates.indexOf(template), 1)
    }
  })
  // @ts-expect-error Nuxt 2 hook
  nuxt.hook('build:templates', async (templates) => {
    const context = {
      nuxt,
      utils: templateUtils,
      app: {
        dir: nuxt.options.srcDir,
        extensions: nuxt.options.extensions,
        plugins: nuxt.options.plugins,
        templates: [
          ...templates.templatesFiles,
          ...virtualTemplates,
        ],
        templateVars: templates.templateVars,
      },
    }
    for await (const template of virtualTemplates) {
      const contents = await compileTemplate({ ...template, src: '' }, context)
      await fsp.mkdir(dirname(template.dst), { recursive: true })
      await fsp.writeFile(template.dst, contents)
    }
  })
}
