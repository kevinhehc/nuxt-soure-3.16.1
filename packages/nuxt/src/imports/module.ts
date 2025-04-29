import { existsSync } from 'node:fs'
import { addBuildPlugin, addTemplate, addTypeTemplate, createIsIgnored, defineNuxtModule, directoryToURL, resolveAlias, tryResolveModule, updateTemplates, useNuxt } from '@nuxt/kit'
import { isAbsolute, join, normalize, relative, resolve } from 'pathe'
import type { Import, Unimport } from 'unimport'
import { createUnimport, scanDirExports, toExports } from 'unimport'
import type { ImportPresetWithDeprecation, ImportsOptions, ResolvedNuxtTemplate } from 'nuxt/schema'
import escapeRE from 'escape-string-regexp'

import { lookupNodeModuleSubpath, parseNodeModulePath } from 'mlly'
import { isDirectory, logger } from '../utils'
import { TransformPlugin } from './transform'
import { appCompatPresets, defaultPresets } from './presets'

export default defineNuxtModule<Partial<ImportsOptions>>({
  // Nuxt 启动时加载这个模块
  // 读取 imports 配置项
  // 注册默认的 presets（就是你之前看到的 vue、nuxt composables 这些默认导入）
  // 配置 virtualImports: ['#imports']
  meta: {
    name: 'nuxt:imports',
    configKey: 'imports',
  },
  defaults: nuxt => ({
    autoImport: true,
    scan: true,
    presets: defaultPresets,
    global: false,
    imports: [],
    dirs: [],
    transform: {
      include: [
        new RegExp('^' + escapeRE(nuxt.options.buildDir)),
      ],
      exclude: undefined,
    },
    virtualImports: ['#imports'],
    polyfills: true,
  }),
  async setup (options, nuxt) {
    // TODO: fix sharing of defaults between invocations of modules
    const presets = JSON.parse(JSON.stringify(options.presets)) as ImportPresetWithDeprecation[]

    if (options.polyfills) {
      presets.push(...appCompatPresets)
    }

    // Allow modules extending sources
    await nuxt.callHook('imports:sources', presets)

    // Filter disabled sources
    // options.sources = options.sources.filter(source => source.disabled !== true)

    const { addons: inlineAddons, ...rest } = options

    const [addons, addonsOptions] = Array.isArray(inlineAddons) ? [inlineAddons] : [[], inlineAddons]

    // Create a context to share state between module internals
    // 所有可以自动导入的符号（比如 useRoute, ref, useFetch）
    // ctx.injectImports() 后续会用来做实际的 import 注入。
    const ctx = createUnimport({
      injectAtEnd: true,
      ...rest,
      addons: {
        addons,
        vueTemplate: options.autoImport,
        vueDirectives: options.autoImport === false ? undefined : true,
        ...addonsOptions,
      },
      presets,
    })

    await nuxt.callHook('imports:context', ctx)

    const isNuxtV4 = nuxt.options.future?.compatibilityVersion === 4

    // composables/ dirs from all layers
    let composablesDirs: string[] = []
    if (options.scan) {
      for (const layer of nuxt.options._layers) {
        // Layer disabled scanning for itself
        if (layer.config?.imports?.scan === false) {
          continue
        }
        composablesDirs.push(resolve(layer.config.srcDir, 'composables'))
        composablesDirs.push(resolve(layer.config.srcDir, 'utils'))

        if (isNuxtV4) {
          composablesDirs.push(resolve(layer.config.rootDir, layer.config.dir?.shared ?? 'shared', 'utils'))
          composablesDirs.push(resolve(layer.config.rootDir, layer.config.dir?.shared ?? 'shared', 'types'))
        }

        for (const dir of (layer.config.imports?.dirs ?? [])) {
          if (!dir) {
            continue
          }
          composablesDirs.push(resolve(layer.config.srcDir, dir))
        }
      }

      await nuxt.callHook('imports:dirs', composablesDirs)
      composablesDirs = composablesDirs.map(dir => normalize(dir))

      // Restart nuxt when composable directories are added/removed
      nuxt.hook('builder:watch', (event, relativePath) => {
        if (!['addDir', 'unlinkDir'].includes(event)) { return }

        const path = resolve(nuxt.options.srcDir, relativePath)
        if (composablesDirs.includes(path)) {
          logger.info(`Directory \`${relativePath}/\` ${event === 'addDir' ? 'created' : 'removed'}`)
          return nuxt.callHook('restart')
        }
      })
    }

    // Support for importing from '#imports'
    addTemplate({
      filename: 'imports.mjs',
      getContents: async () => toExports(await ctx.getImports()) + '\nif (import.meta.dev) { console.warn("[nuxt] `#imports` should be transformed with real imports. There seems to be something wrong with the imports plugin.") }',
    })
    nuxt.options.alias['#imports'] = join(nuxt.options.buildDir, 'imports')

    // Transform to inject imports in production mode
    addBuildPlugin(TransformPlugin({ ctx, options, sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client }))

    const priorities = nuxt.options._layers.map((layer, i) => [layer.config.srcDir, -i] as const).sort(([a], [b]) => b.length - a.length)

    const IMPORTS_TEMPLATE_RE = /\/imports\.(?:d\.ts|mjs)$/
    function isImportsTemplate (template: ResolvedNuxtTemplate) {
      return IMPORTS_TEMPLATE_RE.test(template.filename)
    }

    const isIgnored = createIsIgnored(nuxt)
    const regenerateImports = async () => {
      await ctx.modifyDynamicImports(async (imports) => {
        // Clear old imports
        imports.length = 0

        // Scan for `composables/` and `utils/` directories
        // 动扫描项目内 composables/, utils/ 目录下的 .ts/.js/.vue 文件
        // 把找到的导出（比如 useCounter.ts 里的 useCounter()）也自动加入 ctx.imports 列表
        if (options.scan) {
          const scannedImports = await scanDirExports(composablesDirs, {
            fileFilter: file => !isIgnored(file),
          })
          for (const i of scannedImports) {
            i.priority ||= priorities.find(([dir]) => i.from.startsWith(dir))?.[1]
          }
          imports.push(...scannedImports)
        }

        // Modules extending
        await nuxt.callHook('imports:extend', imports)
        return imports
      })

      await updateTemplates({
        filter: isImportsTemplate,
      })
    }

    await regenerateImports()

    // Generate types
    addDeclarationTemplates(ctx, options)

    // Watch composables/ directory
    nuxt.hook('builder:watch', async (_, relativePath) => {
      const path = resolve(nuxt.options.srcDir, relativePath)
      if (options.scan && composablesDirs.some(dir => dir === path || path.startsWith(dir + '/'))) {
        await regenerateImports()
      }
    })

    // Watch for template generation
    nuxt.hook('app:templatesGenerated', async (_app, templates) => {
      // Only regenerate when non-imports templates are updated
      if (templates.some(t => !isImportsTemplate(t))) {
        await regenerateImports()
      }
    })
  },
})

function addDeclarationTemplates (ctx: Unimport, options: Partial<ImportsOptions>) {
  const nuxt = useNuxt()

  const resolvedImportPathMap = new Map<string, string>()
  const r = ({ from }: Import) => resolvedImportPathMap.get(from)

  const SUPPORTED_EXTENSION_RE = new RegExp(`\\.(${nuxt.options.extensions.map(i => i.replace('.', '')).join('|')})$`)

  const importPaths = nuxt.options.modulesDir.map(dir => directoryToURL(dir))

  // 优化生成类型文件（imports.d.ts）时路径解析的关键逻辑。
  // 预解析每个自动导入符号的 from 来源路径
  // 统一规范路径格式（相对于 .nuxt/types/）
  // 缓存到 resolvedImportPathMap，后面生成 imports.d.ts 时可以直接使用正确路径，不用重复解析。
  async function cacheImportPaths (imports: Import[]) {
    // 遍历 imports，收集 unique 的来源 from
    // imports 是一堆 { name, as, from }
    // from 是比如 'vue', '#app/composables/fetch'
    // 这里去重，只处理每一个 from 来源一次。
    const importSource = Array.from(new Set(imports.map(i => i.from)))
    // skip relative import paths for node_modules that are explicitly installed
    // 并行处理每个导入来源。
    await Promise.all(importSource.map(async (from) => {
      // 跳过已经解析过的或 nuxt 内置依赖
      if (resolvedImportPathMap.has(from) || nuxt._dependencies?.has(from)) {
        // 如果 from 已经有解析结果了，或者是 Nuxt 内置依赖（比如 vue, vue-router），直接跳过，不用处理。
        return
      }

      // 解析别名
      // 比如 #app/composables/fetch → .nuxt/app/composables/fetch
      // resolveAlias 是处理 nuxt.config.ts > alias 配置的。
      let path = resolveAlias(from)

      // 如果路径还不是绝对路径，尝试找出真实模块路径
      if (!isAbsolute(path)) {
        // 如果还不是绝对路径，比如是包名 vue
        // 就用 tryResolveModule 从 node_modules 找出实际的物理路径。
        path = await tryResolveModule(from, importPaths).then(async (r) => {
          if (!r) { return r }

          // 特殊处理 NodeModules 内部结构
          // 如果是 node_modules 的包，比如 @vue/reactivity
          // 它会解析出 dir 和 包名
          // 如果是 Nuxt 已知依赖，可以直接保留 from 不改
          // 否则继续处理子路径（比如 lodash-es/cloneDeep）。
          const { dir, name } = parseNodeModulePath(r)
          if (name && nuxt._dependencies?.has(name)) { return from }

          if (!dir || !name) { return r }
          const subpath = await lookupNodeModuleSubpath(r)
          return join(dir, name, subpath || '')
        }) ?? path
      }

      // 如果是 .ts、.js、.vue 文件
      // 把 .ts、.vue 后缀去掉
      // 避免 import X from './foo.ts' 这种非法的路径出现在 d.ts
      if (existsSync(path) && !(await isDirectory(path))) {
        path = path.replace(SUPPORTED_EXTENSION_RE, '')
      }

      // 把路径改成相对于 .nuxt/types/ 的相对路径
      // 因为生成 imports.d.ts 文件时，必须保证路径是相对于 types 目录的，否则 TS 找不到。
      if (isAbsolute(path)) {
        path = relative(join(nuxt.options.buildDir, 'types'), path)
      }

      // 把最终的 from -> path 结果放入缓存表，供后续生成 .d.ts 时使用。
      resolvedImportPathMap.set(from, path)
    }))

    // 例子
    // 假设你的 imports 是：
    // [
    //   { name: 'ref', from: 'vue' },
    //   { name: 'useFetch', from: '#app/composables/fetch' },
    //   { name: 'cloneDeep', from: 'lodash-es' },
    // ]
    // 经过 cacheImportPaths(imports) 后：
    // resolvedImportPathMap = {
    //   'vue': 'vue',  // 保持原样
    //   '#app/composables/fetch': '../app/composables/fetch',  // 相对于 .nuxt/types
    //   'lodash-es': 'node_modules/lodash-es', // 解析真实 node_modules 路径
    // }
    // 后续 .nuxt/types/imports.d.ts 就会正确生成：
    // export { ref } from 'vue'
    // export { useFetch } from '../app/composables/fetch'
    // export { cloneDeep } from 'node_modules/lodash-es'
    // 保证 TS 补全正确。
  }

  // 生成 .nuxt/imports.mjs
  addTypeTemplate({
    filename: 'imports.d.ts',
    getContents: async ({ nuxt }) => toExports(await ctx.getImports(), nuxt.options.buildDir, true),
  })

  // 生成 .nuxt/types/imports.d.ts
  addTypeTemplate({
    filename: 'types/imports.d.ts',
    getContents: async () => {
      const imports = await ctx.getImports()
      await cacheImportPaths(imports)
      return '// Generated by auto imports\n' + (
        options.autoImport
          ? await ctx.generateTypeDeclarations({ resolvePath: r })
          : '// Implicit auto importing is disabled, you can use explicitly import from `#imports` instead.'
      )
    },
  })

  // 文件	                        内容	                                           作用
  // .nuxt/imports.mjs	          动态导出所有 auto-imports 符号（真实代码 import）	供运行时 #imports 路径使用
  // .nuxt/types/imports.d.ts	    TypeScript 类型声明	                          供 IDE 类型补全
}
