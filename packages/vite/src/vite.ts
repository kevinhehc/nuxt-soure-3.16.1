import { existsSync } from 'node:fs'
import * as vite from 'vite'
import { dirname, join, normalize, resolve } from 'pathe'
import type { Nuxt, NuxtBuilder, ViteConfig } from '@nuxt/schema'
import { addVitePlugin, createIsIgnored, logger, resolvePath, useNitro } from '@nuxt/kit'
// 引入 Rollup 插件 replace，用于替换构建时常量
import replace from '@rollup/plugin-replace'
import type { RollupReplaceOptions } from '@rollup/plugin-replace'
// 引入用于清理文件名的工具
import { sanitizeFilePath } from 'mlly'
// 引入去除 URL 开头 `/` 的工具
import { withoutLeadingSlash } from 'ufo'
// 引入获取文件名的工具
import { filename } from 'pathe/utils'
// 引入模块路径解析方法
import { resolveModulePath } from 'exsolve'
// 引入 TypeScript 配置解析方法
import { resolveTSConfig } from 'pkg-types'

// 引入客户端、服务端构建方法
import { buildClient } from './client'
import { buildServer } from './server'
// 引入热启动函数
import { warmupViteServer } from './utils/warmup'
// 引入 CSS 配置解析方法
import { resolveCSSOptions } from './css'
// 引入日志等级映射表
import { logLevelMap } from './utils/logger'
// 引入 SSR 样式插件
import { ssrStylesPlugin } from './plugins/ssr-styles'
// 引入处理 public 目录的插件
import { VitePublicDirsPlugin } from './plugins/public-dirs'

// 引入 Nuxt 的 dist 路径
import { distDir } from './dirs'

// 定义构建上下文的接口
export interface ViteBuildContext {
  nuxt: Nuxt  // Nuxt 实例
  config: ViteConfig // 合并后的 Vite 配置
  entry: string  // 应用入口路径
  clientServer?: vite.ViteDevServer  // 客户端开发服务器
  ssrServer?: vite.ViteDevServer  // SSR 开发服务器
}

// 实现 NuxtBuilder 的 bundle 方法
export const bundle: NuxtBuilder['bundle'] = async (nuxt) => {
  // 判断是否启用异步入口（entry.async.ts）
  const useAsyncEntry = nuxt.options.experimental.asyncEntry ||
    (nuxt.options.vite.devBundler === 'vite-node' && nuxt.options.dev)
  // 解析最终入口路径
  const entry = await resolvePath(resolve(nuxt.options.appDir, useAsyncEntry ? 'entry.async' : 'entry'))

  // 将 Nuxt 的 dist 目录添加到模块目录中
  nuxt.options.modulesDir.push(distDir)

  // 构造允许访问的目录列表（组件、插件、中间件、布局等）
  let allowDirs = [
    nuxt.options.appDir,
    nuxt.options.workspaceDir,
    ...nuxt.options._layers.map(l => l.config.rootDir),
    ...Object.values(nuxt.apps).flatMap(app => [
      ...app.components.map(c => dirname(c.filePath)),
      ...app.plugins.map(p => dirname(p.src)),
      ...app.middleware.map(m => dirname(m.path)),
      ...Object.values(app.layouts || {}).map(l => dirname(l.file)),
      dirname(nuxt.apps.default!.rootComponent!),
      dirname(nuxt.apps.default!.errorComponent!),
    ]),
  ].filter(d => d && existsSync(d))  // 只保留实际存在的路径

  // 移除嵌套路径，只保留最顶层目录
  for (const dir of allowDirs) {
    allowDirs = allowDirs.filter(d => !d.startsWith(dir) || d === dir)
  }

  // 解构出 $client 和 $server 外的 vite 配置
  const { $client, $server, ...viteConfig } = nuxt.options.vite

  // 获取空模块路径（用于替换 Node 特有模块）
  const mockEmpty = resolveModulePath('mocked-exports/empty', { from: import.meta.url })

  // 创建忽略规则函数
  const isIgnored = createIsIgnored(nuxt)

  // 构建上下文对象 ctx
  const ctx: ViteBuildContext = {
    nuxt,
    entry,
    config: vite.mergeConfig(
      {
        // 设置日志等级
        logLevel: logLevelMap[nuxt.options.logLevel] ?? logLevelMap.info,
        // 设置路径别名
        resolve: {
          alias: {
            ...nuxt.options.alias,
            '#app': nuxt.options.appDir,
            'web-streams-polyfill/ponyfill/es2018': mockEmpty,
            // Cannot destructure property 'AbortController' of ..
            'abort-controller': mockEmpty, // 替换 Node 特有模块
          },
        },
        // 设置 CSS 配置
        css: await resolveCSSOptions(nuxt),
        // 定义全局常量
        define: {
          __NUXT_VERSION__: JSON.stringify(nuxt._version),
          __NUXT_ASYNC_CONTEXT__: nuxt.options.experimental.asyncContext,
        },
        // 构建配置
        build: {
          copyPublicDir: false,  // 不自动复制 public 目录
          rollupOptions: {
            output: {
              // 忽略某些路径生成 source map
              sourcemapIgnoreList: (relativeSourcePath) => {
                return relativeSourcePath.includes('node_modules') || relativeSourcePath.includes(ctx.nuxt.options.buildDir)
              },
              // 清理输出文件名
              sanitizeFileName: sanitizeFilePath,
              // https://github.com/vitejs/vite/tree/main/packages/vite/src/node/build.ts#L464-L478
              // 设置资源文件命名格式
              assetFileNames: nuxt.options.dev
                ? undefined
                : chunk => withoutLeadingSlash(join(nuxt.options.app.buildAssetsDir, `${sanitizeFilePath(filename(chunk.names[0]!))}.[hash].[ext]`)),
            },
          },
          // 构建时监视配置
          watch: {
            chokidar: { ...nuxt.options.watchers.chokidar, ignored: [isIgnored, /[\\/]node_modules[\\/]/] },
            exclude: nuxt.options.ignore,
          },
        },
        // 添加自定义插件
        plugins: [
          // add resolver for files in public assets directories
          // 处理 public 目录中的静态资源
          VitePublicDirsPlugin.vite({
            dev: nuxt.options.dev,
            sourcemap: !!nuxt.options.sourcemap.server,
            baseURL: nuxt.options.app.baseURL,
          }),
          // 替换 global 为 globalThis
          replace({ preventAssignment: true, ...globalThisReplacements }),
        ],
        // 开发服务器配置
        server: {
          watch: { ...nuxt.options.watchers.chokidar, ignored: [isIgnored, /[\\/]node_modules[\\/]/] },
          fs: {
            allow: [...new Set(allowDirs)],// 允许访问的文件系统路径
          },
        },
      } satisfies ViteConfig,
      viteConfig,  // 合并用户自定义 vite 配置
    ),
  }

  // In build mode we explicitly override any vite options that vite is relying on
  // to detect whether to inject production or development code (such as HMR code)
  // 如果是构建模式，禁用热更新
  if (!nuxt.options.dev) {
    ctx.config.server!.watch = undefined
    ctx.config.build!.watch = undefined
  }

  // TODO: this may no longer be needed with most recent vite version
  // 在开发模式下处理多层 Nuxt 项目依赖优化
  if (nuxt.options.dev) {
    // Identify which layers will need to have an extra resolve step.
    const layerDirs: string[] = []
    const delimitedRootDir = nuxt.options.rootDir + '/'
    for (const layer of nuxt.options._layers) {
      if (layer.config.srcDir !== nuxt.options.srcDir && !layer.config.srcDir.startsWith(delimitedRootDir)) {
        layerDirs.push(layer.config.srcDir + '/')
      }
    }
    if (layerDirs.length > 0) {
      // Reverse so longest/most specific directories are searched first
      layerDirs.sort().reverse()
      ctx.nuxt.hook('vite:extendConfig', (config) => {
        const dirs = [...layerDirs]
        config.plugins!.push({
          name: 'nuxt:optimize-layer-deps',
          enforce: 'pre',
          async resolveId (source, _importer) {
            if (!_importer || !dirs.length) { return }
            const importer = normalize(_importer)
            const layerIndex = dirs.findIndex(dir => importer.startsWith(dir))
            // Trigger vite to optimize dependencies imported within a layer, just as if they were imported in final project
            if (layerIndex !== -1) {
              dirs.splice(layerIndex, 1)
              await this.resolve(source, join(nuxt.options.srcDir, 'index.html'), { skipSelf: true }).catch(() => null)
            }
          },
        })
      })
    }
  }

  // Add type-checking
  // 添加类型检查插件（vite-plugin-checker）
  if (!ctx.nuxt.options.test && (ctx.nuxt.options.typescript.typeCheck === true || (ctx.nuxt.options.typescript.typeCheck === 'build' && !ctx.nuxt.options.dev))) {
    const checker = await import('vite-plugin-checker').then(r => r.default)
    addVitePlugin(checker({
      vueTsc: {
        tsconfigPath: await resolveTSConfig(ctx.nuxt.options.rootDir),
      },
    }), { server: nuxt.options.ssr })
  }

  // 执行用户注册的 vite:extend 钩子
  await nuxt.callHook('vite:extend', ctx)

  // 插件中替换 import.meta.*
  nuxt.hook('vite:extendConfig', (config) => {
    const replaceOptions: RollupReplaceOptions = Object.create(null)
    replaceOptions.preventAssignment = true

    for (const key in config.define!) {
      if (key.startsWith('import.meta.')) {
        replaceOptions[key] = config.define![key]
      }
    }

    config.plugins!.push(replace(replaceOptions))
  })

  // 构建模式下启用 SSR 样式插件
  if (!ctx.nuxt.options.dev) {
    const chunksWithInlinedCSS = new Set<string>()
    const clientCSSMap = {}

    nuxt.hook('vite:extendConfig', (config, { isServer }) => {
      config.plugins!.push(ssrStylesPlugin({
        srcDir: ctx.nuxt.options.srcDir,
        clientCSSMap,
        chunksWithInlinedCSS,
        shouldInline: ctx.nuxt.options.features.inlineStyles,
        components: ctx.nuxt.apps.default!.components || [],
        globalCSS: ctx.nuxt.options.css,
        mode: isServer ? 'server' : 'client',
        entry: ctx.entry,
      }))
    })

    // Remove CSS entries for files that will have inlined styles'
    // 在生成 manifest 时移除被内联的 CSS
    ctx.nuxt.hook('build:manifest', (manifest) => {
      for (const [key, entry] of Object.entries(manifest)) {
        const shouldRemoveCSS = chunksWithInlinedCSS.has(key) && !entry.isEntry
        if (entry.isEntry && chunksWithInlinedCSS.has(key)) {
          // @ts-expect-error internal key
          entry._globalCSS = true
        }
        if (shouldRemoveCSS && entry.css) {
          entry.css = []
        }
      }
    })
  }

  // 当开发服务器创建完毕后，监听模板变更并重新加载模块
  nuxt.hook('vite:serverCreated', (server: vite.ViteDevServer, env) => {
    // Invalidate virtual modules when templates are re-generated
    ctx.nuxt.hook('app:templatesGenerated', async (_app, changedTemplates) => {
      await Promise.all(changedTemplates.map(async (template) => {
        for (const mod of server.moduleGraph.getModulesByFile(`virtual:nuxt:${encodeURIComponent(template.dst)}`) || []) {
          server.moduleGraph.invalidateModule(mod)
          await server.reloadModule(mod)
        }
      }))
    })

    // 启动入口预热功能
    if (nuxt.options.vite.warmupEntry !== false) {
      // Don't delay nitro build for warmup
      useNitro().hooks.hookOnce('compiled', () => {
        const start = Date.now()
        warmupViteServer(server, [ctx.entry], env.isServer)
          .then(() => logger.info(`Vite ${env.isClient ? 'client' : 'server'} warmed up in ${Date.now() - start}ms`))
          .catch(logger.error)
      })
    }
  })

  // 执行客户端和服务端构建，并打印耗时日志
  await withLogs(() => buildClient(ctx), 'Vite client built', ctx.nuxt.options.dev)
  await withLogs(() => buildServer(ctx), 'Vite server built', ctx.nuxt.options.dev)
}

// 定义用于将 global. 替换为 globalThis. 的替换表
const globalThisReplacements = Object.fromEntries([';', '(', '{', '}', ' ', '\t', '\n'].map(d => [`${d}global.`, `${d}globalThis.`]))

// 执行函数并输出运行耗时日志
async function withLogs (fn: () => Promise<void>, message: string, enabled = true) {
  if (!enabled) { return fn() }

  const start = performance.now()
  await fn()
  const duration = performance.now() - start
  logger.success(`${message} in ${Math.round(duration)}ms`)
}
