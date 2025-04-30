import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { addBuildPlugin, addComponent, addPlugin, addTemplate, addTypeTemplate, defineNuxtModule, findPath, resolvePath, useNitro } from '@nuxt/kit'
import { dirname, join, relative, resolve } from 'pathe'
import { genImport, genObjectFromRawEntries, genString } from 'knitwork'
import { joinURL } from 'ufo'
import type { Nuxt, NuxtPage } from 'nuxt/schema'
import { createRoutesContext } from 'unplugin-vue-router'
import { resolveOptions } from 'unplugin-vue-router/options'
import type { EditableTreeNode, Options as TypedRouterOptions } from 'unplugin-vue-router'
import { createRouter as createRadixRouter, toRouteMatcher } from 'radix3'

import type { NitroRouteConfig } from 'nitropack'
import { defu } from 'defu'
import { distDir } from '../dirs'
import { resolveTypePath } from '../core/utils/types'
import { logger } from '../utils'
import { normalizeRoutes, resolvePagesRoutes, resolveRoutePaths } from './utils'
import { extractRouteRules, getMappedPages } from './route-rules'
import { PageMetaPlugin } from './plugins/page-meta'
import { RouteInjectionPlugin } from './plugins/route-injection'

const OPTIONAL_PARAM_RE = /^\/?:.*(?:\?|\(\.\*\)\*)$/

const runtimeDir = resolve(distDir, 'pages/runtime')

// 用于收集并解析路由配置文件 router.options 的工具函数，常见于自动生成 vue-router 配置时的构建过程。它支持来自多层模块（layer）、用户自定义和内置默认配置的合并
async function resolveRouterOptions (nuxt: Nuxt, builtInRouterOptions: string) {
  // 函数接收：
  // nuxt：Nuxt 实例，包含配置项如多层模块 _layers；
  // builtInRouterOptions：默认内置的 router.options 文件路径（如 Nuxt 自带的 router 设置）；
  // 返回值是一个 router.options 文件路径列表，供后续构建时按优先级合并使用。

  // context.files 是 router.options 文件的收集结果。
  // 每个文件结构为 { path, optional }：
  // optional: true 表示文件不存在时不报错（用于内置配置）。
  const context = {
    files: [] as Array<{ path: string, optional?: boolean }>,
  }

  // 遍历 nuxt.options._layers 中所有模块（包括当前项目、模块、主题等）；
  // 每层中查找路径为：
  // {srcDir}/{dir.app || 'app'}/router.options
  // 如果文件存在（通过 findPath 判断），添加到 files 数组开头。
  // unshift() 代表高优先级在后面，因为后续 defu 合并时会覆盖前面的设置。
  for (const layer of nuxt.options._layers) {
    const path = await findPath(resolve(layer.config.srcDir, layer.config.dir?.app || 'app', 'router.options'))
    if (path) { context.files.unshift({ path }) }
  }

  // Add default options at beginning
  // 加入一个默认配置（Nuxt 内部使用），并标记为 optional。
  context.files.unshift({ path: builtInRouterOptions, optional: true })

  // 暴露一个钩子，允许模块或插件通过 pages:routerOptions 自定义添加或修改 router.options 文件。
  await nuxt.callHook('pages:routerOptions', context)
  return context.files

  // 举例输出（可能的结果）：
  // [
  //   { path: '/nuxt/internal/router.options', optional: true },
  //   { path: '/project/app/router.options' },
  //   { path: '/theme-module/app/router.options' }
  // ]
}

export default defineNuxtModule({
  meta: {
    name: 'nuxt:pages',
    configKey: 'pages',
  },
  // 默认启用页面系统；
  // 定义扫描页面文件的通配符匹配（.vue, .ts, ...）。
  defaults: nuxt => ({
    enabled: typeof nuxt.options.pages === 'boolean' ? nuxt.options.pages : undefined as undefined | boolean,
    pattern: `**/*{${nuxt.options.extensions.join(',')}}` as string | string[],
  }),
  async setup (_options, nuxt) {
    // 如果 _options 是布尔值（用户直接传了 true/false）：
    // 创建包含 enabled 和 pattern 的对象。
    // pattern 用于匹配 .vue, .ts 等页面扩展名。
    // 如果是对象，直接解构为新的 options。
    const options = typeof _options === 'boolean' ? { enabled: _options ?? nuxt.options.pages, pattern: `**/*{${nuxt.options.extensions.join(',')}}` } : { ..._options }
    // 若 pattern 是数组，使用 Set 去重，防止重复扫描相同模式。
    options.pattern = Array.isArray(options.pattern) ? [...new Set(options.pattern)] : options.pattern

    // useExperimentalTypedPages: 是否启用 typed router（会自动生成 typed-router.d.ts）；
    // 查找内置 router.options.ts 的实际文件路径，作为后续合并配置的基础。
    const useExperimentalTypedPages = nuxt.options.experimental.typedPages
    const builtInRouterOptions = await findPath(resolve(runtimeDir, 'router.options')) || resolve(runtimeDir, 'router.options')

    // Nuxt 支持多层模块（layer / theme），每一层都有可能自带一个 pages/ 目录；
    // 对每一层使用 srcDir + dir.pages 组合出 pages/ 目录绝对路径；
    // 后续用于判断 pages 功能是否可启用（目录存在并非空）。
    const pagesDirs = nuxt.options._layers.map(
      layer => resolve(layer.config.srcDir, (layer.config.rootDir === nuxt.options.rootDir ? nuxt.options : layer.config).dir?.pages || 'pages'),
    )

    // 允许 Nuxt 项目中通过 #vue-router 使用 Vue Router（支持跨平台 alias）；
    // 避免模块和插件硬编码 vue-router 路径。
    nuxt.options.alias['#vue-router'] = 'vue-router'
    const routerPath = await resolveTypePath('vue-router', '', nuxt.options.modulesDir) || 'vue-router'
    // 查找 vue-router 的实际模块路径，注入到 TS 项目中；
    // 确保你能在项目中 import { useRoute } from '#vue-router' 无误；
    // 删除 #vue-router/* 防止不必要的路径映射冲突。
    nuxt.hook('prepare:types', ({ tsConfig }) => {
      tsConfig.compilerOptions ||= {}
      tsConfig.compilerOptions.paths ||= {}
      tsConfig.compilerOptions.paths['#vue-router'] = [routerPath]
      delete tsConfig.compilerOptions.paths['#vue-router/*']
    })

    // Disable module (and use universal router) if pages dir do not exists or user has disabled it
    // isNonEmptyDir：是否存在且不为空的目录，用于判断 pages/ 是否真的有效；
    // userPreference：用户传入的 pages 启用与否偏好（boolean 或 undefined）。
    const isNonEmptyDir = (dir: string) => existsSync(dir) && readdirSync(dir).length
    const userPreference = options.enabled
    // 判断是否启用 pages 系统（重要）
    // 用户是否显式启用；
    // 是否存在自定义 router.options 文件；
    // 是否存在有效的 pages/ 页面文件。
    // 这是一个 异步函数，返回布尔值，表示是否启用 pages 功能。内部包含 4 层判断逻辑：
    const isPagesEnabled = async () => {

      // 如果用户在 nuxt.config.ts 中写了 pages: true/false，直接使用，不再判断其他来源。
      if (typeof userPreference === 'boolean') {
        return userPreference
      }
      // 如果项目或模块中存在实际的 router.options.ts 文件（非 optional），说明用户主动配置了路由系统，自动启用 pages 功能。
      const routerOptionsFiles = await resolveRouterOptions(nuxt, builtInRouterOptions)
      if (routerOptionsFiles.filter(p => !p.optional).length > 0) {
        return true
      }
      // 检查多层模块中的 pages/ 目录是否存在文件。
      // 如果用户确实创建了页面文件，就启用。
      if (pagesDirs.some(dir => isNonEmptyDir(dir))) {
        return true
      }

      // 如果前面都没有触发启用，就尝试使用 options.pattern 规则（如 **/*.vue）去扫描。
      // 若扫描到有效页面，则自动启用。
      // 同时把解析结果写入 nuxt.apps.default.pages 供后续模板使用。
      const pages = await resolvePagesRoutes(options.pattern, nuxt)
      if (pages.length) {
        if (nuxt.apps.default) {
          nuxt.apps.default.pages = pages
        }
        return true
      }

      // 都不满足则禁用
      return false
    }
    // 将计算出的启用状态写入最终配置对象；
    // 后续所有模板生成、类型生成都基于这个值。
    options.enabled = await isPagesEnabled()
    nuxt.options.pages = options
    // For backwards compatibility with `@nuxtjs/i18n` and other modules that serialize `nuxt.options.pages` directly
    // TODO: remove in a future major
    // 一些 Nuxt 模块（如 @nuxtjs/i18n）会序列化 nuxt.options.pages；
    // 为兼容旧逻辑，定义了一个 toString() 方法，返回 enabled 布尔值；
    // 避免页面功能被误判为字符串。
    Object.defineProperty(nuxt.options.pages, 'toString', {
      enumerable: false,
      get: () => () => options.enabled,
    })

    // 这个插件会在开发模式下检测是否使用了 <NuxtPage /> 组件；
    // 避免用户启用了 pages 却忘了使用 <NuxtPage>，导致页面不渲染。
    if (nuxt.options.dev && options.enabled) {
      // Add plugin to check if pages are enabled without NuxtPage being instantiated
      addPlugin(resolve(runtimeDir, 'plugins/check-if-page-unused'))
    }

    // 当页面设置为 SSR 模式（mode: 'server'），但整体项目却是 ssr: false，会发出警告；
    // 提醒开发者启用 componentIslands 或修正配置。
    nuxt.hook('app:templates', (app) => {
      if (!nuxt.options.ssr && app.pages?.some(p => p.mode === 'server')) {
        logger.warn('Using server pages with `ssr: false` is not supported with auto-detected component islands. Set `experimental.componentIslands` to `true`.')
      }
    })

    // Restart Nuxt when pages dir is added or removed
    // 构建一个需要监听变更的路径列表（restartPaths）；
    // 对每一层 layer（包括主项目、多层模块、主题等）：
    // 路径 1：app/router.options.ts（可用于启用路由功能）
    // 路径 2：pages/ 目录（添加或删除页面时需要更新）
    const restartPaths = nuxt.options._layers.flatMap((layer) => {
      const pagesDir = (layer.config.rootDir === nuxt.options.rootDir ? nuxt.options : layer.config).dir?.pages || 'pages'
      return [
        resolve(layer.config.srcDir || layer.cwd, layer.config.dir?.app || 'app', 'router.options.ts'),
        resolve(layer.config.srcDir || layer.cwd, pagesDir),
      ]
    })

    // 监听构建器中发生的文件变更（新增、删除、修改）；
    // 将相对路径转为绝对路径。
    nuxt.hooks.hook('builder:watch', async (event, relativePath) => {
      const path = resolve(nuxt.options.srcDir, relativePath)
      // 判断是否变更的是 router.options.ts 或者 pages/ 目录中的内容；
      // 满足条件则继续检查是否需要重新启用 pages 功能。
      if (restartPaths.some(p => p === path || path.startsWith(p + '/'))) {
        // 重新运行 isPagesEnabled()（你之前发过）来判断当前状态；
        // 如果结果和原本 options.enabled 不一致，表示启用状态发生变化；
        // 触发 Nuxt 自动重启（nuxt.callHook('restart')），以便重新加载 pages 模块。
        const newSetting = await isPagesEnabled()
        if (options.enabled !== newSetting) {
          logger.info('Pages', newSetting ? 'enabled' : 'disabled')
          return nuxt.callHook('restart')
        }
      }
    })

    // 如果 pages 最终判断为关闭状态，则：
    // 添加 fallback router 插件；
    // 保证即使没有页面，也有基本的 Vue Router 支持（手写路由、自定义导航仍可用）。
    if (!options.enabled) {
      addPlugin(resolve(distDir, 'app/plugins/router'))
      // // 类型定义模板输出
      addTemplate({
        filename: 'pages.mjs',
        getContents: () => [
          'export { useRoute } from \'#app/composables/router\'',
          'export const START_LOCATION = Symbol(\'router:start-location\')',
        ].join('\n'),
      })
      // used by `<NuxtLink>`
      // // 类型定义模板输出
      addTemplate({
        filename: 'router.options.mjs',
        getContents: () => {
          return [
            'export const hashMode = false',
            'export default {}',
          ].join('\n')
        },
      })
      // // 类型定义模板输出
      addTypeTemplate({
        filename: 'types/middleware.d.ts',
        getContents: () => [
          'declare module \'nitropack\' {',
          '  interface NitroRouteConfig {',
          '    appMiddleware?: string | string[] | Record<string, boolean>',
          '  }',
          '}',
          'export {}',
        ].join('\n'),
      }, { nuxt: true, nitro: true })
      // 注册一个 空壳版本的 <NuxtPage>，用于开发或特殊项目中没有启用 pages 功能时，防止报错。
      // 这个组件会在控制台提示开发者“未启用 pages/ 路由系统”。
      addComponent({
        name: 'NuxtPage',
        priority: 10, // built-in that we do not expect the user to override
        filePath: resolve(distDir, 'pages/runtime/page-placeholder'),
      })
      // Prerender index if pages integration is not enabled
      // 如果当前为生产环境 + SSR 开启 + 正在构建静态站点（nitro.static = true）+ 启用了链接爬取：
      // 自动将首页 / 添加到 prerender 路由中；
      // 这样即使没有 pages/ 目录也能预渲染一个基础页面（用于托管）。
      nuxt.hook('nitro:init', (nitro) => {
        if (nuxt.options.dev || !nuxt.options.ssr || !nitro.options.static || !nitro.options.prerender.crawlLinks) { return }

        nitro.options.prerender.routes.push('/')
      })
      return
    }

    if (useExperimentalTypedPages) {
      // 定义类型文件输出路径
      const declarationFile = './types/typed-router.d.ts'

      // 使用 unplugin-vue-router 的 API；
      // dts: 类型输出文件；
      // beforeWriteFiles: 类型生成前执行的钩子，用来遍历、修改页面树（重要！）。
      const typedRouterOptions: TypedRouterOptions = {
        routesFolder: [],
        dts: resolve(nuxt.options.buildDir, declarationFile),
        logs: nuxt.options.debug && nuxt.options.debug.router,
        async beforeWriteFiles (rootPage) {
          // 清除旧的页面结构，准备重新构建；
          // 如果 pages 没有手动设定，则调用 resolvePagesRoutes 自动扫描生成。
          rootPage.children.forEach(child => child.delete())
          const pages = nuxt.apps.default?.pages || await resolvePagesRoutes(options.pattern, nuxt)
          if (nuxt.apps.default) {
            nuxt.apps.default.pages = pages
          }
          const addedPagePaths = new Set<string>()
          // 避免路径重复；
          // 页面路径以 / 开头的，直接挂在根节点；
          // 否则挂在当前父节点；
          // 添加元信息、别名、名称等。
          function addPage (parent: EditableTreeNode, page: NuxtPage) {
            // Avoid duplicate keys in the generated RouteNamedMap type
            const absolutePagePath = joinURL(parent.path, page.path)

            // way to add a route without a file, which must be possible
            const route = addedPagePaths.has(absolutePagePath)
              ? parent
              : /^\//.test(page.path)
                // @ts-expect-error TODO: either fix types upstream or figure out another
                // way to add a route without a file, which must be possible
                ? rootPage.insert(page.path, page.file)
                // @ts-expect-error TODO: either fix types upstream or figure out another
                // way to add a route without a file, which must be possible
                : parent.insert(page.path, page.file)

            addedPagePaths.add(absolutePagePath)
            if (page.meta) {
              route.addToMeta(page.meta)
            }
            if (page.alias) {
              route.addAlias(page.alias)
            }
            if (page.name) {
              route.name = page.name
            }
            // TODO: implement redirect support
            // if (page.redirect) {}
            if (page.children) {
              page.children.forEach(child => addPage(route, child))
            }
          }

          // 递归处理每个页面及其子页面，构建出最终的 typed router 路由树。
          for (const page of pages) {
            addPage(rootPage, page)
          }
        },
      }

      // 注册生成的 typed-router.d.ts 文件到类型引用中；
      // 引入 unplugin-vue-router 提供的运行时类型支持（如路由名、参数类型等）。
      nuxt.hook('prepare:types', ({ references }) => {
        // This file will be generated by unplugin-vue-router
        references.push({ path: declarationFile })
        references.push({ types: 'unplugin-vue-router/client' })
      })

      // 使用 createRoutesContext() 创建路由扫描上下文；
      // 创建目标输出目录（确保路径存在）；
      // context.scanPages(false) 触发一次页面扫描（静默生成类型结构）。
      const context = createRoutesContext(resolveOptions(typedRouterOptions))
      const dtsFile = resolve(nuxt.options.buildDir, declarationFile)
      await mkdir(dirname(dtsFile), { recursive: true })
      await context.scanPages(false)

      // 仅在构建阶段或 --prepare 执行时注入类型文件模板；
      // 避免开发时冗余 I/O 操作。
      if (nuxt.options._prepare || !nuxt.options.dev) {
        // TODO: could we generate this from context instead?
        const dts = await readFile(dtsFile, 'utf-8')
        addTemplate({
          filename: 'types/typed-router.d.ts',
          getContents: () => dts,
        })
      }

      // Regenerate types/typed-router.d.ts when adding or removing pages
      // 每次重新生成模板（页面文件变化时）都重新扫描页面结构；
      // 用于更新类型定义文件（如添加新页面时自动补充类型提示）。
      nuxt.hook('app:templatesGenerated', async (_app, _templates, options) => {
        if (!options?.filter || options.filter({ filename: 'routes.mjs' } as any)) {
          await context.scanPages()
        }
      })
    }

    // Add $router types
    // 若启用了 typed pages，则使用 auto-routes 模式，自动映射类型；
    // 否则回退为普通 vue-router。
    nuxt.hook('prepare:types', ({ references }) => {
      references.push({ types: useExperimentalTypedPages ? 'vue-router/auto-routes' : 'vue-router' })
    })

    // Add vue-router route guard imports
    // Nuxt 默认的 #app/composables/router 其实是对 vue-router 的封装；
    // 这里修复路由守卫 onBeforeRouteLeave 等导入路径，避免类型不一致。
    nuxt.hook('imports:sources', (sources) => {
      const routerImports = sources.find(s => s.from === '#app/composables/router' && s.imports.includes('onBeforeRouteLeave'))
      if (routerImports) {
        routerImports.from = 'vue-router'
      }
    })

    // Regenerate templates when adding or removing pages
    // 构建所有需要监听的路径（pages, layouts, middleware）；
    // 当这些路径下有文件变化时，触发重新扫描并更新模板/类型。
    const updateTemplatePaths = nuxt.options._layers.flatMap((l) => {
      const dir = (l.config.rootDir === nuxt.options.rootDir ? nuxt.options : l.config).dir
      return [
        resolve(l.config.srcDir || l.cwd, dir?.pages || 'pages') + '/',
        resolve(l.config.srcDir || l.cwd, dir?.layouts || 'layouts') + '/',
        resolve(l.config.srcDir || l.cwd, dir?.middleware || 'middleware') + '/',
      ]
    })

    // 用于识别一个变动文件是否属于现有页面；
    // 支持递归子页面。
    function isPage (file: string, pages = nuxt.apps.default?.pages): boolean {
      if (!pages) { return false }
      return pages.some(page => page.file === file) || pages.some(page => page.children && isPage(file, page.children))
    }

    // 当 app 模板初始化时（构建阶段），生成页面结构 app.pages；
    // 仅执行一次；
    // 如果已手动设置 app.pages，不会重复扫描；
    // 使用 resolvePagesRoutes() 根据 pages/ 目录生成页面树。
    nuxt.hooks.hookOnce('app:templates', async (app) => {
      app.pages ||= await resolvePagesRoutes(options.pattern, nuxt)
    })

    // 页面、布局、middleware 文件变更时热更新页面路由结构
    // 监听构建器文件变更；
    // 如果启用了 scanPageMeta（扫描 .meta 文件、内联 definePageMeta 等），并且文件是页面 → 强制重扫；
    // 否则只在相关目录变动（如 pages/, layouts/, middleware/）时重建页面结构；
    // 会实时更新 nuxt.apps.default.pages。
    nuxt.hook('builder:watch', async (event, relativePath) => {
      const path = resolve(nuxt.options.srcDir, relativePath)
      const shouldAlwaysRegenerate = nuxt.options.experimental.scanPageMeta && isPage(path)

      if (event === 'change' && !shouldAlwaysRegenerate) { return }

      if (shouldAlwaysRegenerate || updateTemplatePaths.some(dir => path.startsWith(dir))) {
        nuxt.apps.default!.pages = await resolvePagesRoutes(options.pattern, nuxt)
      }
    })

    // 如果用户没有自定义入口组件（仍是默认欢迎页），则替换为 Nuxt 的 app.vue；
    // 自动注册 validate 中间件为全局中间件，用于支持 <NuxtPage> 中的 meta.validate() 函数。
    nuxt.hook('app:resolve', (app) => {
      // Add default layout for pages
      if (app.mainComponent === resolve(nuxt.options.appDir, 'components/welcome.vue')) {
        app.mainComponent = resolve(runtimeDir, 'app.vue')
      }
      app.middleware.unshift({
        name: 'validate',
        path: resolve(runtimeDir, 'validate'),
        global: true,
      })
    })

    // 如果启用了：
    // nitro.options.prerender.crawlLinks = true（启用自动链接爬虫）或
    // 存在 routeRules[x].prerender = true（显式开启 prerender）；
    // 则注册 prerender.server 插件，在服务器构建阶段参与路径收集。
    nuxt.hook('app:resolve', (app) => {
      const nitro = useNitro()
      if (nitro.options.prerender.crawlLinks || Object.values(nitro.options.routeRules).some(rule => rule.prerender)) {
        app.plugins.push({
          src: resolve(runtimeDir, 'plugins/prerender.server'),
          mode: 'server',
        })
      }
    })

    // Record all pages for use in prerendering
    // processPages 递归遍历 pages 树，将符合条件的路径加入 prerenderRoutes 集合；
    // 跳过动态路径（含 : 的）；
    // 如果页面是“可选参数路径”（如 [slug]?）且无子路由，则记录上级路径；
    // 最终用于静态生成。
    const prerenderRoutes = new Set<string>()

    function processPages (pages: NuxtPage[], currentPath = '/') {
      for (const page of pages) {
        // Add root of optional dynamic paths and catchalls
        if (OPTIONAL_PARAM_RE.test(page.path) && !page.children?.length) {
          prerenderRoutes.add(currentPath)
        }

        // Skip dynamic paths
        if (page.path.includes(':')) { continue }

        const route = joinURL(currentPath, page.path)
        prerenderRoutes.add(route)

        if (page.children) {
          processPages(page.children, route)
        }
      }
    }

    // 在构建过程中，当所有页面解析完毕时触发；
    // 非开发模式下执行；
    // 使用 processPages(pages) 将所有静态页面路径（非动态）收集到 prerenderRoutes；
    // 这些将用于后续 prerender 阶段。
    nuxt.hook('pages:extend', (pages) => {
      if (nuxt.options.dev) { return }

      prerenderRoutes.clear()
      processPages(pages)
    })

    // 如果在开发模式下或启用了 hashMode，跳过 prerender 路由注入；
    // 后续针对不同场景作处理。
    nuxt.hook('nitro:build:before', (nitro) => {
      if (nuxt.options.dev || nuxt.options.router.options.hashMode) { return }

      // Inject page patterns that explicitly match `prerender: true` route rule

      // 利用 routeRules（用户定义的规则）匹配收集到的路径；
      // 如果匹配项中存在 prerender: true，就将该路径加入 prerender.routes；
      // 灵活支持配置式路由预渲染。
      if (!nitro.options.static && !nitro.options.prerender.crawlLinks) {
        const routeRulesMatcher = toRouteMatcher(createRadixRouter({ routes: nitro.options.routeRules }))
        for (const route of prerenderRoutes) {
          const rules = defu({} as Record<string, any>, ...routeRulesMatcher.matchAll(route).reverse())
          if (rules.prerender) {
            nitro.options.prerender.routes.push(route)
          }
        }
      }

      // 如果是 SSR 静态站，并启用了爬虫模式，则注入一个“初始提示路由”作为起点（通常为 /）；
      // 剩余页面会在客户端爬取过程中自动发现。
      if (!nitro.options.static || !nitro.options.prerender.crawlLinks) { return }

      // Only hint the first route when `ssr: true` and no routes are provided
      // as the rest will be injected at runtime when this is prerendered
      if (nuxt.options.ssr) {
        // 在非 SSR 模式下，所有静态页面都需提前注入（客户端不会爬取）；
        // 合并用户配置与自动生成的页面路径。
        const [firstPage] = [...prerenderRoutes].sort()
        nitro.options.prerender.routes.push(firstPage || '/')
        return
      }

      // Prerender all non-dynamic page routes when generating `ssr: false` app
      for (const route of nitro.options.prerender.routes || []) {
        prerenderRoutes.add(route)
      }
      nitro.options.prerender.routes = Array.from(prerenderRoutes)
    })

    // 注入 Nuxt 页面相关的组合式 API：
    // definePageMeta()：定义页面级别的 meta 信息，如 middleware, layout, transition；
    // useLink()：Nuxt 版 router-link 辅助组合函数。
    nuxt.hook('imports:extend', (imports) => {
      imports.push(
        { name: 'definePageMeta', as: 'definePageMeta', from: resolve(runtimeDir, 'composables') },
        { name: 'useLink', as: 'useLink', from: 'vue-router' },
      )
      // 自动导入 defineRouteRules()，用于在页面文件中直接写 inline 路由规则，如：
      // defineRouteRules({ prerender: true, headers: { 'x-robots-tag': 'noindex' } })
      if (nuxt.options.experimental.inlineRouteRules) {
        imports.push({ name: 'defineRouteRules', as: 'defineRouteRules', from: resolve(runtimeDir, 'composables') })
      }
    })

    // 判断是否启用 experimental.inlineRouteRules
    // 该功能默认是关闭的，只有显式设置：
    // export default defineNuxtConfig({
    //   experimental: {
    //     inlineRouteRules: true
    //   }
    // })
    // 时才启用。
    if (nuxt.options.experimental.inlineRouteRules) {
      // Track mappings of absolute files to globs
      // 映射页面文件路径到 route globs（通配路径）
      let pageToGlobMap = {} as { [absolutePath: string]: string | null }
      // 用于后续提取规则时把文件 → 路径转换。
      nuxt.hook('pages:extend', (pages) => { pageToGlobMap = getMappedPages(pages) })

      // Extracted route rules defined inline in pages
      // 用于记录已提取的 inline route rules
      // 比如
      // {
      //   '/blog/:slug': {
      //     prerender: true,
      //     headers: { 'x-robots-tag': 'noindex' }
      //   }
      // }
      const inlineRules = {} as { [glob: string]: NitroRouteConfig }

      // Allow telling Nitro to reload route rules
      // 把 inlineRules 和原始 routeRules 合并后重新注入；
      // defu() 是深度合并工具，确保新规则优先，但旧规则保留。
      let updateRouteConfig: () => void | Promise<void>
      nuxt.hook('nitro:init', (nitro) => {
        updateRouteConfig = () => nitro.updateConfig({ routeRules: defu(inlineRules, nitro.options._config.routeRules) })
      })

      // 从页面文件中提取 defineRouteRules() 调用生成的规则对象；
      // 如果有映射不到路径的文件，则打印错误提示；
      // 如果移除了规则（或内容为空），则从 inlineRules 删除对应项。
      const updatePage = async function updatePage (path: string) {
        const glob = pageToGlobMap[path]
        const code = path in nuxt.vfs ? nuxt.vfs[path]! : await readFile(path!, 'utf-8')
        try {
          const extractedRule = await extractRouteRules(code, path)
          if (extractedRule) {
            if (!glob) {
              const relativePath = relative(nuxt.options.srcDir, path)
              logger.error(`Could not set inline route rules in \`~/${relativePath}\` as it could not be mapped to a Nitro route.`)
              return
            }

            inlineRules[glob] = extractedRule
          } else if (glob) {
            delete inlineRules[glob]
          }
        } catch (e: any) {
          if (e.toString().includes('Error parsing route rules')) {
            const relativePath = relative(nuxt.options.srcDir, path)
            logger.error(`Error parsing route rules within \`~/${relativePath}\`. They should be JSON-serializable.`)
          } else {
            logger.error(e)
          }
        }
      }

      // 如果变化的是页面文件（在映射中），则：
      // unlink → 删除规则；
      // 否则 → 调用 updatePage() 提取新规则；
      // 最后执行 updateRouteConfig() 注入到 Nitro 配置。
      nuxt.hook('builder:watch', async (event, relativePath) => {
        const path = resolve(nuxt.options.srcDir, relativePath)
        if (!(path in pageToGlobMap)) { return }
        if (event === 'unlink') {
          delete inlineRules[path]
          delete pageToGlobMap[path]
        } else {
          await updatePage(path)
        }
        await updateRouteConfig?.()
      })

      nuxt.hooks.hookOnce('pages:extend', async () => {
        for (const page in pageToGlobMap) { await updatePage(page) }
        await updateRouteConfig?.()
      })
    }

    // 在测试 & 开发模式下启用；
    // 增加一个 catch-all 的伪路由 /__nuxt_component_test__/*；
    // 渲染 component-stub.vue 占位组件，避免测试某些组件时路由不匹配导致 404；
    // 常用于 Vite 模拟组件加载或 Vitest 中的组件隔离测试。
    const componentStubPath = await resolvePath(resolve(runtimeDir, 'component-stub'))
    if (nuxt.options.test && nuxt.options.dev) {
      // add component testing route so 404 won't be triggered
      nuxt.hook('pages:extend', (routes) => {
        routes.push({
          _sync: true,
          path: '/__nuxt_component_test__/:pathMatch(.*)',
          file: componentStubPath,
        })
      })
    }

    // App Manifest 启用时，客户端会在路由跳转前使用中间件处理跳转（redirect）；
    // 为了避免这些路径触发 SSR 报错（找不到页面），这里将所有 redirect 路由也注册为页面；
    // 使用 component-stub.vue 占位（实际不会显示），仅用于 router 识别路径存在；
    // 动态路径的 ** 会被转为 Vue Router 格式的 :pathMatch(.*)。
    if (nuxt.options.experimental.appManifest) {
      // Add all redirect paths as valid routes to router; we will handle these in a client-side middleware
      // when the app manifest is enabled.
      nuxt.hook('pages:extend', (routes) => {
        const nitro = useNitro()
        let resolvedRoutes: string[]
        for (const [path, rule] of Object.entries(nitro.options.routeRules)) {
          if (!rule.redirect) { continue }
          resolvedRoutes ||= routes.flatMap(route => resolveRoutePaths(route))
          // skip if there's already a route matching this path
          if (resolvedRoutes.includes(path)) { continue }
          routes.push({
            _sync: true,
            path: path.replace(/\/[^/]*\*\*/, '/:pathMatch(.*)'),
            file: componentStubPath,
          })
        }
      })
    }

    // Extract macros from pages
    // 注册一个 Vite 插件 PageMetaPlugin()，用于提取页面中使用的宏（macros）；
    // 比如 definePageMeta()、defineRouteRules() 等；
    // 插件的主要功能是：
    // 编译时分析页面文件；
    // 将 definePageMeta({...}) 解析为静态 JSON meta 数据；
    // 使这些元数据可被 Nuxt 使用（用于布局切换、transition、keepalive 等功能）；
    // 支持 sourcemap，用于调试或追踪宏定义位置。
    nuxt.hook('modules:done', () => {
      addBuildPlugin(PageMetaPlugin({
        dev: nuxt.options.dev,
        sourcemap: !!nuxt.options.sourcemap.server || !!nuxt.options.sourcemap.client,
        isPage,
        routesPath: resolve(nuxt.options.buildDir, 'routes.mjs'),
      }))
    })

    // Add prefetching support for middleware & layouts
    // 注册页面插件和路由插件
    // 注入客户端插件 prefetch.client：
    // 支持页面组件或 layout 中定义的 definePageMeta({ preload: true }) 等行为；
    // 优化用户导航体验，提前加载关联资源（middleware、layout、组件等）。
    addPlugin(resolve(runtimeDir, 'plugins/prefetch.client'))

    // Add build plugin to ensure template $route is kept in sync with `<NuxtPage>`
    // 启用 <template> 中自动注入 $route 引用的功能；
    // 比如你在模板中使用 $route.query.id，Nuxt 可以静态分析出来并为其生成 TS 类型提示。
    if (nuxt.options.experimental.templateRouteInjection) {
      addBuildPlugin(RouteInjectionPlugin(nuxt), { server: false })
    }

    // Add router plugin
    // 注册页面插件和路由插件
    // 注入 plugins/router，这是 Nuxt 构建核心 router 实例的插件；
    // 用于设置路由模式、导航守卫、hook 注入等功能。
    addPlugin(resolve(runtimeDir, 'plugins/router'))

    const getSources = (pages: NuxtPage[]): string[] => pages
      .filter(p => Boolean(p.file))
      .flatMap(p =>
        [relative(nuxt.options.srcDir, p.file as string), ...(p.children?.length ? getSources(p.children) : [])],
      )

    // Do not prefetch page chunks
    // 移除不必要的 chunk（页面代码分片）
    nuxt.hook('build:manifest', (manifest) => {
      //
      if (nuxt.options.dev) { return }
      const sourceFiles = nuxt.apps.default?.pages?.length ? getSources(nuxt.apps.default.pages) : []

      // 仅在 生产构建 中进行优化；
      // 遍历页面树中所有 .vue 文件路径，生成 sourceFiles 列表；
      for (const [key, chunk] of Object.entries(manifest)) {
        if (chunk.src && Object.values(nuxt.apps).some(app => app.pages?.some(page => page.mode === 'server' && page.file === join(nuxt.options.srcDir, chunk.src!)))) {
          // 移除仅用于 server 的页面 chunk
          delete manifest[key]
          continue
        }
        if (chunk.isEntry) {
          chunk.dynamicImports =
            chunk.dynamicImports?.filter(i => !sourceFiles.includes(i))
        }
      }
    })

    // 用于后续路由构建（如 routes.mjs）时判断组件运行环境；
    // Nuxt 支持按需构建组件：
    // client-component.vue 只在浏览器运行；
    // server-component.vue 只在服务器渲染时用到。
    const serverComponentRuntime = await findPath(join(distDir, 'components/runtime/server-component')) ?? join(distDir, 'components/runtime/server-component')
    const clientComponentRuntime = await findPath(join(distDir, 'components/runtime/client-component')) ?? join(distDir, 'components/runtime/client-component')

    // Add routes template
    // 类型定义模板输出
    addTemplate({
      filename: 'routes.mjs',
      getContents ({ app }) {
        if (!app.pages) { return ROUTES_HMR_CODE + 'export default []' }
        const { routes, imports } = normalizeRoutes(app.pages, new Set(), {
          serverComponentRuntime,
          clientComponentRuntime,
          overrideMeta: !!nuxt.options.experimental.scanPageMeta,
        })
        return ROUTES_HMR_CODE + [...imports, `export default ${routes}`].join('\n')
      },
    })

    // Add vue-router import for `<NuxtLayout>` integration
    addTemplate({
      filename: 'pages.mjs',
      getContents: () => 'export { START_LOCATION, useRoute } from \'vue-router\'',
    })

    nuxt.options.vite.resolve ||= {}
    nuxt.options.vite.resolve.dedupe ||= []
    nuxt.options.vite.resolve.dedupe.push('vue-router')

    // Add router options template
    // 类型定义模板输出
    addTemplate({
      filename: 'router.options.mjs',
      getContents: async ({ nuxt }) => {
        // Scan and register app/router.options files
        const routerOptionsFiles = await resolveRouterOptions(nuxt, builtInRouterOptions)

        const configRouterOptions = genObjectFromRawEntries(Object.entries(nuxt.options.router.options)
          .map(([key, value]) => [key, genString(value as string)]))

        return [
          ...routerOptionsFiles.map((file, index) => genImport(file.path, `routerOptions${index}`)),
          `const configRouterOptions = ${configRouterOptions}`,
          `export const hashMode = ${[...routerOptionsFiles.filter(o => o.path !== builtInRouterOptions).map((_, index) => `routerOptions${index}.hashMode`).reverse(), nuxt.options.router.options.hashMode].join(' ?? ')}`,
          'export default {',
          '...configRouterOptions,',
          ...routerOptionsFiles.map((_, index) => `...routerOptions${index},`),
          '}',
        ].join('\n')
      },
    })

    // 类型定义模板输出
    addTypeTemplate({
      filename: 'types/middleware.d.ts',
      getContents: ({ nuxt, app }) => {
        const composablesFile = relative(join(nuxt.options.buildDir, 'types'), resolve(runtimeDir, 'composables'))
        const namedMiddleware = app.middleware.filter(mw => !mw.global)
        return [
          'import type { NavigationGuard } from \'vue-router\'',
          `export type MiddlewareKey = ${namedMiddleware.map(mw => genString(mw.name)).join(' | ') || 'never'}`,
          `declare module ${genString(composablesFile)} {`,
          '  interface PageMeta {',
          '    middleware?: MiddlewareKey | NavigationGuard | Array<MiddlewareKey | NavigationGuard>',
          '  }',
          '}',
        ].join('\n')
      },
    })

    // 类型定义模板输出
    addTypeTemplate({
      filename: 'types/nitro-middleware.d.ts',
      getContents: ({ app }) => {
        const namedMiddleware = app.middleware.filter(mw => !mw.global)
        return [
          `export type MiddlewareKey = ${namedMiddleware.map(mw => genString(mw.name)).join(' | ') || 'never'}`,
          'declare module \'nitropack\' {',
          '  interface NitroRouteConfig {',
          '    appMiddleware?: MiddlewareKey | MiddlewareKey[] | Record<MiddlewareKey, boolean>',
          '  }',
          '}',
        ].join('\n')
      },
    }, { nuxt: true, nitro: true })

    // 类型定义模板输出
    addTypeTemplate({
      filename: 'types/layouts.d.ts',
      getContents: ({ nuxt, app }) => {
        const composablesFile = relative(join(nuxt.options.buildDir, 'types'), resolve(runtimeDir, 'composables'))
        return [
          'import type { ComputedRef, MaybeRef } from \'vue\'',
          `export type LayoutKey = ${Object.keys(app.layouts).map(name => genString(name)).join(' | ') || 'string'}`,
          `declare module ${genString(composablesFile)} {`,
          '  interface PageMeta {',
          '    layout?: MaybeRef<LayoutKey | false> | ComputedRef<LayoutKey | false>',
          '  }',
          '}',
        ].join('\n')
      },
    })

    // add page meta types if enabled
    // 类型定义模板输出
    if (nuxt.options.experimental.viewTransition) {
      addTypeTemplate({
        filename: 'types/view-transitions.d.ts',
        getContents: ({ nuxt }) => {
          const runtimeDir = resolve(distDir, 'pages/runtime')
          const composablesFile = relative(join(nuxt.options.buildDir, 'types'), resolve(runtimeDir, 'composables'))
          return [
            'import type { ComputedRef, MaybeRef } from \'vue\'',
            `declare module ${genString(composablesFile)} {`,
            '  interface PageMeta {',
            '    viewTransition?: boolean | \'always\'',
            '  }',
            '}',
          ].join('\n')
        },
      })
    }

    // Add <NuxtPage>
    // 使用 addComponent 将该组件注册到全局组件系统中。
    // 最终你在任何页面中使用 <NuxtPage />，都将自动解析为加载并渲染当前匹配的路由页面组件。比如：
    // <template>
    //   <NuxtLayout>
    //     <NuxtPage />
    //   </NuxtLayout>
    // </template>
    // 就是 Nuxt 默认的 app.vue 页面结构。
    addComponent({
      // name: 'NuxtPage'	注册组件名称，允许开发者在模板中直接使用 <NuxtPage />>
      // priority: 10	设置组件注册的优先级，数字越大优先级越高，防止用户误覆盖
      // filePath	指向组件源码的路径，最终会从这里加载实际实现代码
      name: 'NuxtPage',
      priority: 10, // built-in that we do not expect the user to override
      filePath: resolve(distDir, 'pages/runtime/page'),
    })
  },
})

// 路由热更新代码
const ROUTES_HMR_CODE = /* js */`
if (import.meta.hot) {
  import.meta.hot.accept((mod) => {
    const router = import.meta.hot.data.router
    const generateRoutes = import.meta.hot.data.generateRoutes
    if (!router || !generateRoutes) {
      import.meta.hot.invalidate('[nuxt] Cannot replace routes because there is no active router. Reloading.')
      return
    }
    router.clearRoutes()
    const routes = generateRoutes(mod.default || mod)
    function addRoutes (routes) {
      for (const route of routes) {
        router.addRoute(route)
      }
      router.replace(router.currentRoute.value.fullPath)
    }
    if (routes && 'then' in routes) {
      routes.then(addRoutes)
    } else {
      addRoutes(routes)
    }
  })
}

export function handleHotUpdate(_router, _generateRoutes) {
  if (import.meta.hot) {
    import.meta.hot.data ||= {}
    import.meta.hot.data.router = _router
    import.meta.hot.data.generateRoutes = _generateRoutes
  }
}
`
