import { existsSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize, relative, resolve } from 'pathe'
import { addBuildPlugin, addPluginTemplate, addTemplate, addTypeTemplate, addVitePlugin, defineNuxtModule, findPath, resolveAlias } from '@nuxt/kit'
import type { Component, ComponentsDir, ComponentsOptions } from 'nuxt/schema'

import { resolveModulePath } from 'exsolve'
import { distDir } from '../dirs'
import { logger } from '../utils'
import { componentNamesTemplate, componentsIslandsTemplate, componentsMetadataTemplate, componentsPluginTemplate, componentsTypeTemplate } from './templates'
import { scanComponents } from './scan'

import { LoaderPlugin } from './plugins/loader'
import { ComponentsChunkPlugin, IslandsTransformPlugin } from './plugins/islands-transform'
import { TransformPlugin } from './plugins/transform'
import { TreeShakeTemplatePlugin } from './plugins/tree-shake'
import { ComponentNamePlugin } from './plugins/component-names'
import { LazyHydrationTransformPlugin } from './plugins/lazy-hydration-transform'

const isPureObjectOrString = (val: any) => (!Array.isArray(val) && typeof val === 'object') || typeof val === 'string'
const isDirectory = (p: string) => { try { return statSync(p).isDirectory() } catch { return false } }
const SLASH_SEPARATOR_RE = /[\\/]/
function compareDirByPathLength ({ path: pathA }: { path: string }, { path: pathB }: { path: string }) {
  return pathB.split(SLASH_SEPARATOR_RE).filter(Boolean).length - pathA.split(SLASH_SEPARATOR_RE).filter(Boolean).length
}

const DEFAULT_COMPONENTS_DIRS_RE = /\/components(?:\/(?:global|islands))?$/
const STARTER_DOT_RE = /^\./g

export type getComponentsT = (mode?: 'client' | 'server' | 'all') => Component[]

// 模块自动扫描项目中的组件目录，根据模式（client/server/all）分类组件，注册各种编译期插件，实现：
// 能力	简介
// 自动组件导入	无需手动 import，使用组件即自动引入
// 支持组件模式	client-only、server-only、通用组件（mode: client/server/all）
// islands 架构支持	局部 SSR / CSR 渲染块（NuxtIsland）
// lazy hydration	延迟挂载组件：idle、visible、click 等策略
// 组件 chunk 分离	每个 client-only 组件打成独立 chunk，实现按需加载
// 热重载支持	server-only 组件 HMR 支持
// 自动生成 TS 类型定义	支持 components.d.ts 自动类型提示

// Transform 插件注入
// addBuildPlugin(TransformPlugin(...))
// addBuildPlugin(LoaderPlugin(...))
// addBuildPlugin(LazyHydrationTransformPlugin(...))
// addBuildPlugin(IslandsTransformPlugin(...))
// addBuildPlugin(TreeShakeTemplatePlugin(...))
// 这些插件在 Vue 文件 transform 阶段执行，处理：
//
//
// 插件	             功能
// TransformPlugin	分析组件结构、注入运行时信息
// LoaderPlugin	注册组件 runtime loader，支持延迟导入
// LazyHydrationTransformPlugin	根据 hydrate-on-* 自动转换组件名
// IslandsTransformPlugin	转换 slot / nuxt-client 标签为 <NuxtIsland> 结构
// TreeShakeTemplatePlugin	剔除未在模板中使用的组件，tree-shaking
export default defineNuxtModule<ComponentsOptions>({
  meta: {
    name: 'nuxt:components',
    configKey: 'components',
  },
  defaults: {
    dirs: [],
  },
  async setup (componentOptions, nuxt) {
    let componentDirs: ComponentsDir[] = []
    const context = {
      components: [] as Component[],
    }

    const getComponents: getComponentsT = (mode) => {
      return (mode && mode !== 'all')
        ? context.components.filter(c => c.mode === mode || c.mode === 'all' || (c.mode === 'server' && !context.components.some(otherComponent => otherComponent.mode !== 'server' && otherComponent.pascalName === c.pascalName)))
        : context.components
    }

    if (nuxt.options.experimental.normalizeComponentNames) {
      addBuildPlugin(ComponentNamePlugin({ sourcemap: !!nuxt.options.sourcemap.client, getComponents }), { server: false })
      addBuildPlugin(ComponentNamePlugin({ sourcemap: !!nuxt.options.sourcemap.server, getComponents }), { client: false })
    }

    const normalizeDirs = (dir: any, cwd: string, options?: { priority?: number }): ComponentsDir[] => {
      if (Array.isArray(dir)) {
        return dir.map(dir => normalizeDirs(dir, cwd, options)).flat().sort(compareDirByPathLength)
      }
      if (dir === true || dir === undefined) {
        return [
          { priority: options?.priority || 0, path: resolve(cwd, 'components/islands'), island: true },
          { priority: options?.priority || 0, path: resolve(cwd, 'components/global'), global: true },
          { priority: options?.priority || 0, path: resolve(cwd, 'components') },
        ]
      }
      if (typeof dir === 'string') {
        return [
          { priority: options?.priority || 0, path: resolve(cwd, resolveAlias(dir)) },
        ]
      }
      if (!dir) {
        return []
      }
      const dirs: ComponentsDir[] = (dir.dirs || [dir]).map((dir: any): ComponentsDir => typeof dir === 'string' ? { path: dir } : dir).filter((_dir: ComponentsDir) => _dir.path)
      return dirs.map(_dir => ({
        priority: options?.priority || 0,
        ..._dir,
        path: resolve(cwd, resolveAlias(_dir.path)),
      }))
    }

    // Resolve dirs
    nuxt.hook('app:resolve', async () => {
      // components/ dirs from all layers
      const allDirs = nuxt.options._layers
        .map(layer => normalizeDirs(layer.config.components, layer.config.srcDir, { priority: layer.config.srcDir === nuxt.options.srcDir ? 1 : 0 }))
        .flat()

      await nuxt.callHook('components:dirs', allDirs)

      componentDirs = allDirs.filter(isPureObjectOrString).map((dir) => {
        const dirOptions: ComponentsDir = typeof dir === 'object' ? dir : { path: dir }
        const dirPath = resolveAlias(dirOptions.path)
        const transpile = typeof dirOptions.transpile === 'boolean' ? dirOptions.transpile : 'auto'
        const extensions = (dirOptions.extensions || nuxt.options.extensions).map(e => e.replace(STARTER_DOT_RE, ''))

        const present = isDirectory(dirPath)
        if (!present && !DEFAULT_COMPONENTS_DIRS_RE.test(dirOptions.path)) {
          logger.warn('Components directory not found: `' + dirPath + '`')
        }

        return {
          global: componentOptions.global,
          ...dirOptions,
          // TODO: https://github.com/nuxt/framework/pull/251
          enabled: true,
          path: dirPath,
          extensions,
          pattern: dirOptions.pattern || `**/*.{${extensions.join(',')},}`,
          ignore: [
            '**/*{M,.m,-m}ixin.{js,ts,jsx,tsx}', // ignore mixins
            '**/*.d.{cts,mts,ts}', // .d.ts files
            ...(dirOptions.ignore || []),
          ],
          transpile: (transpile === 'auto' ? dirPath.includes('node_modules') : transpile),
        }
      }).filter(d => d.enabled)

      componentDirs = [
        ...componentDirs.filter(dir => !dir.path.includes('node_modules')),
        ...componentDirs.filter(dir => dir.path.includes('node_modules')),
      ]

      nuxt.options.build!.transpile!.push(...componentDirs.filter(dir => dir.transpile).map(dir => dir.path))
    })

    // components.d.ts
    addTypeTemplate(componentsTypeTemplate)
    // components.plugin.mjs
    addPluginTemplate(componentsPluginTemplate)
    // component-names.mjs
    addTemplate(componentNamesTemplate)
    // components.islands.mjs
    addTemplate({ ...componentsIslandsTemplate, filename: 'components.islands.mjs' })

    if (componentOptions.generateMetadata) {
      addTemplate(componentsMetadataTemplate)
    }

    const serverComponentRuntime = await findPath(join(distDir, 'components/runtime/server-component')) ?? join(distDir, 'components/runtime/server-component')
    addBuildPlugin(TransformPlugin(nuxt, { getComponents, serverComponentRuntime, mode: 'server' }), { server: true, client: false })
    addBuildPlugin(TransformPlugin(nuxt, { getComponents, serverComponentRuntime, mode: 'client' }), { server: false, client: true })

    // Do not prefetch global components chunks
    nuxt.hook('build:manifest', (manifest) => {
      const sourceFiles = getComponents().filter(c => c.global).map(c => relative(nuxt.options.srcDir, c.filePath))

      for (const chunk of Object.values(manifest)) {
        if (chunk.isEntry) {
          chunk.dynamicImports =
            chunk.dynamicImports?.filter(i => !sourceFiles.includes(i))
        }
      }
    })

    // Restart dev server when component directories are added/removed
    nuxt.hook('builder:watch', (event, relativePath) => {
      if (!['addDir', 'unlinkDir'].includes(event)) {
        return
      }

      const path = resolve(nuxt.options.srcDir, relativePath)
      if (componentDirs.some(dir => dir.path === path)) {
        logger.info(`Directory \`${relativePath}/\` ${event === 'addDir' ? 'created' : 'removed'}`)
        return nuxt.callHook('restart')
      }
    })

    const serverPlaceholderPath = await findPath(join(distDir, 'app/components/server-placeholder')) ?? join(distDir, 'app/components/server-placeholder')

    // Scan components and add to plugin
    nuxt.hook('app:templates', async (app) => {
      // 描 components/、components/global、components/islands 等目录，收集：
      // 文件路径
      // 模式（client/server/all）
      // 组件名称（PascalCase、KebabCase）
      // 是否全局注册
      // 这些信息储存在 context.components 中，供后续插件使用。
      const newComponents = await scanComponents(componentDirs, nuxt.options.srcDir!)
      await nuxt.callHook('components:extend', newComponents)
      // add server placeholder for .client components server side. issue: #7085
      for (const component of newComponents) {
        if (!(component as any /* untyped internal property */)._scanned && !(component.filePath in nuxt.vfs) && isAbsolute(component.filePath) && !existsSync(component.filePath)) {
          // attempt to resolve component path
          component.filePath = resolveModulePath(resolveAlias(component.filePath), { try: true, extensions: nuxt.options.extensions }) ?? component.filePath
        }
        if (component.mode === 'client' && !newComponents.some(c => c.pascalName === component.pascalName && c.mode === 'server')) {
          newComponents.push({
            ...component,
            _raw: true,
            mode: 'server',
            filePath: serverPlaceholderPath,
            chunkName: 'components/' + component.kebabName,
          })
        }
        if (component.mode === 'server' && !nuxt.options.ssr && !newComponents.some(other => other.pascalName === component.pascalName && other.mode === 'client')) {
          logger.warn(`Using server components with \`ssr: false\` is not supported with auto-detected component islands. If you need to use server component \`${component.pascalName}\`, set \`experimental.componentIslands\` to \`true\`.`)
        }
      }
      context.components = newComponents
      app.components = newComponents
    })

    nuxt.hook('prepare:types', ({ tsConfig }) => {
      tsConfig.compilerOptions!.paths['#components'] = [resolve(nuxt.options.buildDir, 'components')]
    })

    if (nuxt.options.experimental.treeshakeClientOnly) {
      addBuildPlugin(TreeShakeTemplatePlugin({ sourcemap: !!nuxt.options.sourcemap.server, getComponents }), { client: false })
    }

    const clientDelayedComponentRuntime = await findPath(join(distDir, 'components/runtime/lazy-hydrated-component')) ?? join(distDir, 'components/runtime/lazy-hydrated-component')

    const sharedLoaderOptions = {
      getComponents,
      clientDelayedComponentRuntime,
      serverComponentRuntime,
      srcDir: nuxt.options.srcDir,
      transform: typeof nuxt.options.components === 'object' && !Array.isArray(nuxt.options.components) ? nuxt.options.components.transform : undefined,
      experimentalComponentIslands: !!nuxt.options.experimental.componentIslands,
    }

    addBuildPlugin(LoaderPlugin({ ...sharedLoaderOptions, sourcemap: !!nuxt.options.sourcemap.client, mode: 'client' }), { server: false })
    addBuildPlugin(LoaderPlugin({ ...sharedLoaderOptions, sourcemap: !!nuxt.options.sourcemap.server, mode: 'server' }), { client: false })

    if (nuxt.options.experimental.lazyHydration) {
      addBuildPlugin(LazyHydrationTransformPlugin({
        ...sharedLoaderOptions,
        sourcemap: !!(nuxt.options.sourcemap.server || nuxt.options.sourcemap.client),
      }), { prepend: true })
    }

    if (nuxt.options.experimental.componentIslands) {
      const selectiveClient = typeof nuxt.options.experimental.componentIslands === 'object' && nuxt.options.experimental.componentIslands.selectiveClient

      addVitePlugin({
        name: 'nuxt-server-component-hmr',
        handleHotUpdate (ctx) {
          const components = getComponents()
          const filePath = normalize(ctx.file)
          const comp = components.find(c => c.filePath === filePath)
          if (comp?.mode === 'server') {
            ctx.server.ws.send({
              event: `nuxt-server-component:${comp.pascalName}`,
              type: 'custom',
            })
          }
        },
      }, { server: false })

      addBuildPlugin(IslandsTransformPlugin({ getComponents, selectiveClient }), { client: false })

      // TODO: refactor this
      nuxt.hook('vite:extendConfig', (config, { isClient }) => {
        config.plugins ||= []

        if (isClient && selectiveClient) {
          writeFileSync(join(nuxt.options.buildDir, 'components-chunk.mjs'), 'export const paths = {}')
          if (!nuxt.options.dev) {
            config.plugins.push(ComponentsChunkPlugin.vite({
              getComponents,
              buildDir: nuxt.options.buildDir,
            }))
          } else {
            writeFileSync(join(nuxt.options.buildDir, 'components-chunk.mjs'), `export const paths = ${JSON.stringify(
              getComponents().filter(c => c.mode === 'client' || c.mode === 'all').reduce((acc, c) => {
                if (c.filePath.endsWith('.vue') || c.filePath.endsWith('.js') || c.filePath.endsWith('.ts')) { return Object.assign(acc, { [c.pascalName]: `/@fs/${c.filePath}` }) }
                const filePath = existsSync(`${c.filePath}.vue`) ? `${c.filePath}.vue` : existsSync(`${c.filePath}.js`) ? `${c.filePath}.js` : `${c.filePath}.ts`
                return Object.assign(acc, { [c.pascalName]: `/@fs/${filePath}` })
              }, {} as Record<string, string>),
            )}`)
          }
        }
      })

      for (const key of ['rspack:config', 'webpack:config'] as const) {
        nuxt.hook(key, (configs) => {
          configs.forEach((config) => {
            const mode = config.name === 'client' ? 'client' : 'server'
            config.plugins ||= []

            if (mode !== 'server') {
              writeFileSync(join(nuxt.options.buildDir, 'components-chunk.mjs'), 'export const paths = {}')
            }
          })
        })
      }
    }
  },
})
