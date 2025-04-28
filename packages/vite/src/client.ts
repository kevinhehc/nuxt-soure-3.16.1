// 引入类型，用于处理 HTTP 请求和响应
import type { IncomingMessage, ServerResponse } from 'node:http'
// 工具库，用于路径拼接与解析
import { join, resolve } from 'pathe'
// 导入 Vite 核心功能
import * as vite from 'vite'
// 引入 Vue 插件，支持 Vue SFC 文件的编译
import vuePlugin from '@vitejs/plugin-vue'
// 支持 JSX 的 Vue 插件
import viteJsxPlugin from '@vitejs/plugin-vue-jsx'
// 引入 Vite 构建和服务配置类型
import type { BuildOptions, ServerOptions } from 'vite'
// Nuxt 的日志工具
import { logger } from '@nuxt/kit'
// 获取可用端口的工具
import { getPort } from 'get-port-please'
// URL 工具函数
import { joinURL, withoutLeadingSlash } from 'ufo'
// 对象合并工具，支持深度合并
import { defu } from 'defu'
// 定义 node 环境变量别名
import { defineEnv } from 'unenv'
// 用于解析模块路径的工具
import { resolveModulePath } from 'exsolve'
// h3 框架的工具，用于处理事件和跨域
import { defineEventHandler, handleCors, setHeader } from 'h3'
// 引入 Nuxt Vite 配置类型
import type { ViteConfig } from '@nuxt/schema'

// 引入构建上下文类型
import type { ViteBuildContext } from './vite'
// 引入多个自定义插件
import { DevStyleSSRPlugin } from './plugins/dev-ssr-css'
import { RuntimePathsPlugin } from './plugins/paths'
import { TypeCheckPlugin } from './plugins/type-check'
import { ModulePreloadPolyfillPlugin } from './plugins/module-preload-polyfill'
import { ViteNodePlugin } from './vite-node'
// 创建自定义 Vite 日志工具
import { createViteLogger } from './utils/logger'

// 主函数：用于构建 Nuxt 客户端端代码
export async function buildClient (ctx: ViteBuildContext) {

  // Node 兼容性处理（可选）
  const nodeCompat = ctx.nuxt.options.experimental.clientNodeCompat
    ? {
        alias: defineEnv({
          nodeCompat: true,
          resolve: true,
        }).env.alias,
        define: {
          global: 'globalThis',
        },
      }
    : { alias: {}, define: {} }

  // 创建 Vite 客户端配置
  const clientConfig: ViteConfig = vite.mergeConfig(ctx.config, vite.mergeConfig({
    configFile: false,
    // 基本路径配置 设置构建资源的基础路径：开发环境使用拼接路径，生产环境使用相对路径。
    base: ctx.nuxt.options.dev
      ? joinURL(ctx.nuxt.options.app.baseURL.replace(/^\.\//, '/') || '/', ctx.nuxt.options.app.buildAssetsDir)
      : './',
    // 渲染内联资源路径配置
    experimental: {
      // 对于 asset 文件，使用相对路径；其他使用运行时变量。
      renderBuiltUrl: (filename, { type, hostType }) => {
        if (hostType !== 'js' || type === 'asset') {
          // In CSS we only use relative paths until we craft a clever runtime CSS hack
          return { relative: true }
        }


        //  阶段	         发生了什么和负责的地方
        // 1. 解析	       你在代码里写了 import logo from '@/assets/logo.png'
        // 2. 依赖收集	   Vite 发现这是个静态资源，它根据配置（比如 assetsInclude）去处理
        // 3. 插占位符	   Vite 在 开发模式 或 构建预处理阶段，把资源替换成一个特殊占位符，比如 __VITE_ASSET__logo_abcd1234_png	Vite 核心源码，特别是 vite/src/node/plugins/asset.ts
        // 4. 后期替换	   真正打包的时候，Vite 再把占位符换成实际的 URL，比如 /assets/logo.abcd1234.png
        // 5. 检测	       在你看到的 RuntimePathsPlugin 里，VITE_ASSET_RE 用来检测代码中有没有这种占位符
        // 路径的修改
        return { runtime: `globalThis.__publicAssetsURL(${JSON.stringify(filename)})` }
      },
    },
    css: {
      devSourcemap: !!ctx.nuxt.options.sourcemap.client,
    },
    // 定义全局常量（define 字段）
    define: {
      'process.env.NODE_ENV': JSON.stringify(ctx.config.mode),
      'process.server': false,
      'process.client': true,
      'process.browser': true,
      'process.nitro': false,
      'process.prerender': false,
      'import.meta.server': false,
      'import.meta.client': true,
      'import.meta.browser': true,
      'import.meta.nitro': false,
      'import.meta.prerender': false,
      'module.hot': false,
      ...nodeCompat.define,
    },
    // 依赖优化（optimizeDeps）
    optimizeDeps: {
      entries: [ctx.entry],
      include: [],
      // We exclude Vue and Nuxt common dependencies from optimization
      // as they already ship ESM.
      //
      // This will help to reduce the chance for users to encounter
      // common chunk conflicts that causing browser reloads.
      // We should also encourage module authors to add their deps to
      // `exclude` if they ships bundled ESM.
      //
      // Also since `exclude` is inert, it's safe to always include
      // all possible deps even if they are not used yet.
      //
      // @see https://github.com/antfu/nuxt-better-optimize-deps#how-it-works
      // 明确不需要优化的依赖（这些已是 ESM 模块），避免二次打包和冲突。
      exclude: [
        // Vue
        'vue',
        '@vue/runtime-core',
        '@vue/runtime-dom',
        '@vue/reactivity',
        '@vue/shared',
        '@vue/devtools-api',
        'vue-router',
        'vue-demi',

        // Nuxt
        'nuxt',
        'nuxt/app',

        // Nuxt Deps
        '@unhead/vue',
        'consola',
        'defu',
        'devalue',
        'h3',
        'hookable',
        'klona',
        'ofetch',
        'pathe',
        'ufo',
        'unctx',
        'unenv',

        // these will never be imported on the client
        '#app-manifest',
      ],
    },
    // 模块解析配置（resolve.alias）
    resolve: {
      alias: {
        // user aliases
        ...nodeCompat.alias,
        ...ctx.config.resolve?.alias,
        '#internal/nitro': join(ctx.nuxt.options.buildDir, 'nitro.client.mjs'),
        // work around vite optimizer bug
        '#app-manifest': resolveModulePath('mocked-exports/empty', { from: import.meta.url }),
      },
      dedupe: [
        'vue',
      ],
    },
    // 缓存、输出目录和 Rollup 构建配置
    cacheDir: resolve(ctx.nuxt.options.rootDir, ctx.config.cacheDir ?? 'node_modules/.cache/vite', 'client'),
    build: {
      sourcemap: ctx.nuxt.options.sourcemap.client ? ctx.config.build?.sourcemap ?? ctx.nuxt.options.sourcemap.client : false,
      manifest: 'manifest.json',
      outDir: resolve(ctx.nuxt.options.buildDir, 'dist/client'),
      rollupOptions: {
        input: { entry: ctx.entry },
      },
    },
    // 插件注册
    plugins: [
      DevStyleSSRPlugin({
        srcDir: ctx.nuxt.options.srcDir,
        buildAssetsURL: joinURL(ctx.nuxt.options.app.baseURL, ctx.nuxt.options.app.buildAssetsDir),
      }),
      RuntimePathsPlugin({
        sourcemap: !!ctx.nuxt.options.sourcemap.client,
      }),
      ViteNodePlugin(ctx),
    ],
    appType: 'custom',
    // Server 相关配置
    server: {
      warmup: {
        clientFiles: [ctx.entry],
      },
      middlewareMode: true,
    },
  } satisfies vite.InlineConfig, ctx.nuxt.options.vite.$client || {}))

  // 日志系统替换为 Nuxt 自定义
  clientConfig.customLogger = createViteLogger(clientConfig)

  // In build mode we explicitly override any vite options that vite is relying on
  // to detect whether to inject production or development code (such as HMR code)
  // 非开发模式：禁用 HMR
  if (!ctx.nuxt.options.dev) {
    clientConfig.server!.hmr = false
  }

  // Inject an h3-based CORS handler in preference to vite's
  // 关闭 Vite 默认 CORS，使用 h3 提供的
  const useViteCors = clientConfig.server?.cors !== undefined
  if (!useViteCors) {
    clientConfig.server!.cors = false
  }

  // We want to respect users' own rollup output options
  // 输出配置优化：输出文件名带 hash
  const fileNames = withoutLeadingSlash(join(ctx.nuxt.options.app.buildAssetsDir, '[hash].js'))
  clientConfig.build!.rollupOptions = defu(clientConfig.build!.rollupOptions!, {
    output: {
      chunkFileNames: ctx.nuxt.options.dev ? undefined : fileNames,
      entryFileNames: ctx.nuxt.options.dev ? 'entry.js' : fileNames,
    } satisfies NonNullable<BuildOptions['rollupOptions']>['output'],
  }) as any

  // HMR 配置补全（开发环境）
  if (clientConfig.server && clientConfig.server.hmr !== false) {
    const serverDefaults: Omit<ServerOptions, 'hmr'> & { hmr: Exclude<ServerOptions['hmr'], boolean> } = {
      hmr: {
        protocol: ctx.nuxt.options.devServer.https ? 'wss' : undefined,
      },
    }
    if (typeof clientConfig.server.hmr !== 'object' || !clientConfig.server.hmr.server) {
      const hmrPortDefault = 24678 // Vite's default HMR port
      serverDefaults.hmr!.port = await getPort({
        port: hmrPortDefault,
        ports: Array.from({ length: 20 }, (_, i) => hmrPortDefault + 1 + i),
      })
    }
    if (ctx.nuxt.options.devServer.https) {
      serverDefaults.https = ctx.nuxt.options.devServer.https === true ? {} : ctx.nuxt.options.devServer.https
    }
    clientConfig.server = defu(clientConfig.server, serverDefaults as ViteConfig['server'])
  }

  // Add analyze plugin if needed
  // 插件扩展（分析插件 + TS 类型检查 + preload polyfill）
  if (!ctx.nuxt.options.test && ctx.nuxt.options.build.analyze && (ctx.nuxt.options.build.analyze === true || ctx.nuxt.options.build.analyze.enabled)) {
    clientConfig.plugins!.push(...await import('./plugins/analyze').then(r => r.analyzePlugin(ctx)))
  }

  // Add type checking client panel
  if (!ctx.nuxt.options.test && ctx.nuxt.options.typescript.typeCheck === true && ctx.nuxt.options.dev) {
    clientConfig.plugins!.push(TypeCheckPlugin({ sourcemap: !!ctx.nuxt.options.sourcemap.client }))
  }

  clientConfig.plugins!.push(ModulePreloadPolyfillPlugin({
    sourcemap: !!ctx.nuxt.options.sourcemap.client,
    entry: ctx.entry,
  }))


  // 调用钩子，允许用户扩展配置
  await ctx.nuxt.callHook('vite:extendConfig', clientConfig, { isClient: true, isServer: false })

  // Vue 插件注册（必须放在最前）
  clientConfig.plugins!.unshift(
    vuePlugin(clientConfig.vue),
    viteJsxPlugin(clientConfig.vueJsx),
  )

  // 钩子：配置已解析
  await ctx.nuxt.callHook('vite:configResolved', clientConfig, { isClient: true, isServer: false })

  // Prioritize `optimizeDeps.exclude`. If same dep is in `include` and `exclude`, remove it from `include`
  // 优化 include/exclude 冲突
  clientConfig.optimizeDeps!.include = clientConfig.optimizeDeps!.include!
    .filter(dep => !clientConfig.optimizeDeps!.exclude!.includes(dep))

  if (ctx.nuxt.options.dev) {
    // Dev 启动 Vite 开发服务器 插入中间件来跳过 transform，增加跨域处理。
    const viteServer = await vite.createServer(clientConfig)
    ctx.clientServer = viteServer
    ctx.nuxt.hook('close', () => viteServer.close())
    await ctx.nuxt.callHook('vite:serverCreated', viteServer, { isClient: true, isServer: false })
    const transformHandler = viteServer.middlewares.stack.findIndex(m => m.handle instanceof Function && m.handle.name === 'viteTransformMiddleware')
    viteServer.middlewares.stack.splice(transformHandler, 0, {
      route: '',
      handle: (req: IncomingMessage & { _skip_transform?: boolean }, res: ServerResponse, next: (err?: any) => void) => {
        // 'Skip' the transform middleware
        if (req._skip_transform) { req.url = joinURL('/__skip_vite', req.url!) }
        next()
      },
    })

    const viteMiddleware = defineEventHandler(async (event) => {
      const viteRoutes: string[] = []
      for (const viteRoute of viteServer.middlewares.stack) {
        const m = viteRoute.route
        if (m.length > 1) {
          viteRoutes.push(m)
        }
      }
      if (!event.path.startsWith(clientConfig.base!) && !viteRoutes.some(route => event.path.startsWith(route))) {
        // @ts-expect-error _skip_transform is a private property
        event.node.req._skip_transform = true
      } else if (!useViteCors) {
        const isPreflight = handleCors(event, ctx.nuxt.options.devServer.cors)
        if (isPreflight) {
          return null
        }
        setHeader(event, 'Vary', 'Origin')
      }

      // Workaround: vite devmiddleware modifies req.url
      const _originalPath = event.node.req.url
      await new Promise((resolve, reject) => {
        viteServer.middlewares.handle(event.node.req, event.node.res, (err: Error) => {
          event.node.req.url = _originalPath
          return err ? reject(err) : resolve(null)
        })
      })
    })
    await ctx.nuxt.callHook('server:devHandler', viteMiddleware)
  } else {
    // Build 生产模式：执行构建
    logger.info('Building client...')
    const start = Date.now()
    logger.restoreAll()
    await vite.build(clientConfig)
    logger.wrapAll()
    await ctx.nuxt.callHook('vite:compiled')
    logger.success(`Client built in ${Date.now() - start}ms`)
  }
}
