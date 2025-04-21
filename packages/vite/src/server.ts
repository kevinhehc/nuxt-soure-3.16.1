import { resolve } from 'pathe'
import * as vite from 'vite'
import vuePlugin from '@vitejs/plugin-vue'
import viteJsxPlugin from '@vitejs/plugin-vue-jsx'
import { logger, resolvePath } from '@nuxt/kit'
import { joinURL, withTrailingSlash, withoutLeadingSlash } from 'ufo'
import type { ViteConfig } from '@nuxt/schema'
import defu from 'defu'
import type { Nitro } from 'nitropack'
import escapeStringRegexp from 'escape-string-regexp'
import type { ViteBuildContext } from './vite'
import { createViteLogger } from './utils/logger'
import { initViteNodeServer } from './vite-node'
import { writeManifest } from './manifest'
import { transpile } from './utils/transpile'
import { createSourcemapPreserver } from './plugins/nitro-sourcemap'

// 主要的函数：构建服务器端 bundle
export async function buildServer (ctx: ViteBuildContext) {
  // helper 用于决定是否使用 globalThis 访问公共路径工具
  const helper = ctx.nuxt.options.nitro.imports !== false ? '' : 'globalThis.'
  // entry 文件：SSR 模式用 ctx.entry，否则用 entry-spa
  const entry = ctx.nuxt.options.ssr ? ctx.entry : await resolvePath(resolve(ctx.nuxt.options.appDir, 'entry-spa'))
  // 合并默认 Vite 配置和 Nuxt 的服务器端 Vite 配置
  const serverConfig: ViteConfig = vite.mergeConfig(ctx.config, vite.mergeConfig({
    // 不使用 vite.config.ts 文件
    configFile: false,
    // 开发时设置 base 路径
    base: ctx.nuxt.options.dev
      ? joinURL(ctx.nuxt.options.app.baseURL.replace(/^\.\//, '/') || '/', ctx.nuxt.options.app.buildAssetsDir)
      : undefined,
    experimental: {
      // 自定义资源路径的生成逻辑
      renderBuiltUrl: (filename, { type, hostType }) => {
        if (hostType !== 'js') {
          // In CSS we only use relative paths until we craft a clever runtime CSS hack
          // CSS 等使用相对路径
          return { relative: true }
        }
        if (type === 'public') {
          return { runtime: `${helper}__publicAssetsURL(${JSON.stringify(filename)})` }
        }
        if (type === 'asset') {
          const relativeFilename = filename.replace(withTrailingSlash(withoutLeadingSlash(ctx.nuxt.options.app.buildAssetsDir)), '')
          return { runtime: `${helper}__buildAssetsURL(${JSON.stringify(relativeFilename)})` }
        }
      },
    },
    css: {
      // 是否生成 CSS 的 source map
      devSourcemap: !!ctx.nuxt.options.sourcemap.server,
    },
    define: {
      // 为服务器端构建定义环境变量，防止错误地引用浏览器 API
      'process.server': true,
      'process.client': false,
      'process.browser': false,
      'import.meta.server': true,
      'import.meta.client': false,
      'import.meta.browser': false,
      'window': 'undefined',
      'document': 'undefined',
      'navigator': 'undefined',
      'location': 'undefined',
      'XMLHttpRequest': 'undefined',
    },
    optimizeDeps: {
      // 不自动扫描依赖
      noDiscovery: true,
    },
    resolve: {
      // 设置模块解析条件（比如适配边缘平台）
      conditions: ((ctx.nuxt as any)._nitro as Nitro)?.options.exportConditions,
    },
    ssr: {
      // SSR 构建时 external 指定不打包的模块
      external: [
        '#internal/nitro', '#internal/nitro/utils',
      ],
      noExternal: [
        ...transpile({ isServer: true, isDev: ctx.nuxt.options.dev }),
        '/__vue-jsx',
        '#app',
        /^nuxt(\/|$)/,
        /(nuxt|nuxt3|nuxt-nightly)\/(dist|src|app)/,
      ],
    },
    cacheDir: resolve(ctx.nuxt.options.rootDir, ctx.config.cacheDir ?? 'node_modules/.cache/vite', 'server'),
    build: {
      // we'll display this in nitro build output
      reportCompressedSize: false,
      sourcemap: ctx.nuxt.options.sourcemap.server ? ctx.config.build?.sourcemap ?? ctx.nuxt.options.sourcemap.server : false,
      // 输出目录
      outDir: resolve(ctx.nuxt.options.buildDir, 'dist/server'),
      ssr: true,
      rollupOptions: {
        // 指定入口文件
        input: { server: entry },
        external: [
          '#internal/nitro',
          '#internal/nuxt/paths',
          '#app-manifest',
          '#shared',
          new RegExp('^' + escapeStringRegexp(withTrailingSlash(resolve(ctx.nuxt.options.rootDir, ctx.nuxt.options.dir.shared)))),
        ],
        output: {
          preserveModules: true,
          entryFileNames: '[name].mjs',
          format: 'module',
          generatedCode: {
            symbols: true, // temporary fix for https://github.com/vuejs/core/issues/8351,
            constBindings: true,
          },
        },
        // 忽略某些警告信息
        onwarn (warning, rollupWarn) {
          if (warning.code && ['UNUSED_EXTERNAL_IMPORT'].includes(warning.code)) {
            return
          }
          rollupWarn(warning)
        },
      },
    },
    server: {
      warmup: {
        ssrFiles: [ctx.entry],
      },
      // https://github.com/vitest-dev/vitest/issues/229#issuecomment-1002685027
      preTransformRequests: false,
      hmr: false,
    },
  } satisfies vite.InlineConfig, ctx.nuxt.options.vite.$server || {}))

  // 移除可能影响构建的 manualChunks 配置
  if (serverConfig.build?.rollupOptions?.output && !Array.isArray(serverConfig.build.rollupOptions.output)) {
    delete serverConfig.build.rollupOptions.output.manualChunks
  }

  // tell rollup's nitro build about the original sources of the generated vite server build
  // 如果开启 server 端 source map 且是生产环境
  if (ctx.nuxt.options.sourcemap.server && !ctx.nuxt.options.dev) {
    const { vitePlugin, nitroPlugin } = createSourcemapPreserver()
    serverConfig.plugins!.push(vitePlugin)
    ctx.nuxt.hook('nitro:build:before', (nitro) => {
      nitro.options.rollupConfig = defu(nitro.options.rollupConfig, {
        plugins: [nitroPlugin],
      })
    })
  }

  // 设置自定义日志记录器
  serverConfig.customLogger = createViteLogger(serverConfig, { hideOutput: !ctx.nuxt.options.dev })

  // 触发 Nuxt 钩子 vite:extendConfig，允许外部扩展配置
  await ctx.nuxt.callHook('vite:extendConfig', serverConfig, { isClient: false, isServer: true })

  // 插入 Vue 插件
  serverConfig.plugins!.unshift(
    vuePlugin(serverConfig.vue),
    viteJsxPlugin(serverConfig.vueJsx),
  )

  // 生产环境中收集并替换 Vue feature flags
  if (!ctx.nuxt.options.dev) {
    serverConfig.plugins!.push({
      name: 'nuxt:nitro:vue-feature-flags',
      configResolved (config) {
        for (const key in config.define) {
          if (key.startsWith('__VUE')) {
            // tree-shake vue feature flags for non-node targets
            ((ctx.nuxt as any)._nitro as Nitro).options.replace[key] = config.define[key]
          }
        }
      },
    })
  }

  // 通知配置已解析完成
  await ctx.nuxt.callHook('vite:configResolved', serverConfig, { isClient: false, isServer: true })

  const onBuild = () => ctx.nuxt.callHook('vite:compiled')

  // Production build
  // 生产构建流程
  if (!ctx.nuxt.options.dev) {
    const start = Date.now()
    logger.info('Building server...')
    logger.restoreAll()
    await vite.build(serverConfig)
    logger.wrapAll()
    // Write production client manifest
    // 写入资源清单
    await writeManifest(ctx)
    await onBuild()
    logger.success(`Server built in ${Date.now() - start}ms`)
    return
  }

  // Write dev client manifest
  // 开发模式写入资源清单
  await writeManifest(ctx)

  // 非 SSR 模式则无需启动 dev server
  if (!ctx.nuxt.options.ssr) {
    await onBuild()
    return
  }

  // Start development server
  // 创建 Vite 开发服务器
  const viteServer = await vite.createServer(serverConfig)
  ctx.ssrServer = viteServer

  // Close server on exit
  // 程序关闭时关闭 dev server
  ctx.nuxt.hook('close', () => viteServer.close())

  // 通知 dev server 创建完成
  await ctx.nuxt.callHook('vite:serverCreated', viteServer, { isClient: false, isServer: true })

  // Initialize plugins
  // 初始化插件（主要是 HMR）
  await viteServer.pluginContainer.buildStart({})

  // 判断使用新版 bundler 还是 legacy bundler
  if (ctx.config.devBundler !== 'legacy') {
    await initViteNodeServer(ctx)
  } else {
    logger.info('Vite server using legacy server bundler...')
    await import('./dev-bundler').then(r => r.initViteDevBundler(ctx, onBuild))
  }
}
