import { writeFile } from 'node:fs/promises' // 从 Node.js 的 fs 模块中导入 writeFile，用于异步写入文件
import { pathToFileURL } from 'node:url' // 将文件路径转换为 URL 格式（file://），用于动态导入等用途
import { createApp, createError, defineEventHandler, toNodeListener } from 'h3' // 从 h3 框架导入创建应用、错误处理、事件处理器和将其转换为 Node.js 监听器的工具
import { ViteNodeServer } from 'vite-node/server' // 从 vite-node/server 导入 ViteNodeServer，用于在开发模式下运行 SSR 模块
import { isAbsolute, normalize, resolve } from 'pathe' // 导入路径处理工具，用于处理文件路径的拼接和标准化
// import { addDevServerHandler } from '@nuxt/kit'  // 已注释：用于以后可能替代中间件注册方式
import { isFileServingAllowed } from 'vite' // 判断某个文件是否允许被 Vite 静态服务
import type { ModuleNode, ViteDevServer, Plugin as VitePlugin } from 'vite' // 导入 Vite 的类型定义
import { getQuery } from 'ufo' // 获取 URL 查询参数的工具
import { normalizeViteManifest } from 'vue-bundle-renderer' // 规范化 Vite 的 manifest 格式，供 Vue SSR 使用
import { distDir } from './dirs' // 导入 Nuxt 构建产物的输出目录
import type { ViteBuildContext } from './vite' // 导入构建上下文类型定义
import { isCSS } from './utils' // 判断文件是否是 CSS 的工具函数

// TODO: Remove this in favor of registerViteNodeMiddleware
// after Nitropack or h3 allows adding middleware after setup
// : 等 Nitropack 或 h3 支持在 setup 后注册中间件后再移除该函数
export function ViteNodePlugin (ctx: ViteBuildContext): VitePlugin {
  // Store the invalidates for the next rendering
  // 保存待失效模块的集合（用于触发热更新）
  const invalidates = new Set<string>()

  // 将某个模块标记为失效
  function markInvalidate (mod: ModuleNode) {
    if (!mod.id) { return }  // 如果模块没有 id，跳过
    if (invalidates.has(mod.id)) { return } // 如果已标记，跳过
    invalidates.add(mod.id)  // 添加到失效列表
    markInvalidates(mod.importers)  // 递归标记其导入者为失效
  }

  // 批量标记模块为失效
  function markInvalidates (mods?: ModuleNode[] | Set<ModuleNode>) {
    // 如果为空，跳过
    if (!mods) { return }
    for (const mod of mods) {
      markInvalidate(mod)// 遍历所有模块并标记
    }
  }

  return {
    name: 'nuxt:vite-node-server',  // 插件名
    enforce: 'post',  // 插件执行顺序在其他插件之后
    configureServer (server) {
      // 添加中间件，处理 Vite Node 的请求
      server.middlewares.use('/__nuxt_vite_node__', toNodeListener(createViteNodeApp(ctx, invalidates)))

      // invalidate changed virtual modules when templates are regenerated
      // 模板生成后，标记相关虚拟模块为失效
      ctx.nuxt.hook('app:templatesGenerated', (_app, changedTemplates) => {
        for (const template of changedTemplates) {
          const mods = server.moduleGraph.getModulesByFile(`virtual:nuxt:${encodeURIComponent(template.dst)}`)

          for (const mod of mods || []) {
            markInvalidate(mod)
          }
        }
      })

      // 监听所有文件变更，标记对应模块为失效
      server.watcher.on('all', (event, file) => {
        markInvalidates(server.moduleGraph.getModulesByFile(normalize(file)))
      })
    },
  }
}

// TODO: Use this when Nitropack or h3 allows adding middleware after setup
// 等支持 setup 后中间件注册后使用该方式替代
// export function registerViteNodeMiddleware (ctx: ViteBuildContext) {
//   addDevServerHandler({
//     route: '/__nuxt_vite_node__/',
//     handler: createViteNodeApp(ctx).handler,
//   })
// }

// 生成 SSR 使用的 manifest（包括 CSS 列表）
function getManifest (ctx: ViteBuildContext) {
  const css = new Set<string>()
  for (const key of ctx.ssrServer!.moduleGraph.urlToModuleMap.keys()) {
    if (isCSS(key)) {
      const query = getQuery(key)
      if ('raw' in query) { continue }
      const importers = ctx.ssrServer!.moduleGraph.urlToModuleMap.get(key)?.importers
      if (importers && [...importers].every(i => i.id && 'raw' in getQuery(i.id))) {
        continue  // 如果导入者都是 raw 模块，也跳过
      }
      css.add(key)  // 否则添加到 CSS 列表
    }
  }

  // 使用 vue-bundle-renderer 规范化 manifest 结构
  const manifest = normalizeViteManifest({
    '@vite/client': {
      file: '@vite/client',
      css: [...css],
      module: true,
      isEntry: true,
    },
    [ctx.entry]: {
      file: ctx.entry,
      isEntry: true,
      module: true,
      resourceType: 'script',
    },
  })

  return manifest
}

// 创建处理 SSR 模块请求的 App 应用
function createViteNodeApp (ctx: ViteBuildContext, invalidates: Set<string> = new Set()) {
  // 创建 h3 应用
  const app = createApp()

  let _node: ViteNodeServer | undefined
  // 获取（或初始化）vite-node 的服务器端实例
  function getNode (server: ViteDevServer) {
    return _node ||= new ViteNodeServer(server, {
      deps: {
        inline: [/^#/, /\?/],  // 内联处理部分依赖（如虚拟模块）
      },
      transformMode: {
        ssr: [/.*/], // 所有模块都用 SSR 模式转译
        web: [],
      },
    })
  }

  // 添加 manifest 接口，返回当前 CSS 资源
  app.use('/manifest', defineEventHandler(() => {
    const manifest = getManifest(ctx)
    return manifest
  }))

  // 添加 invalidates 接口，返回失效模块 id，并清空失效列表
  app.use('/invalidates', defineEventHandler(() => {
    const ids = Array.from(invalidates)
    invalidates.clear()
    return ids
  }))

  // 添加模块路径解析接口
  const RESOLVE_RE = /^\/(?<id>[^?]+)(?:\?importer=(?<importer>.*))?$/
  app.use('/resolve', defineEventHandler(async (event) => {
    const { id, importer } = event.path.match(RESOLVE_RE)?.groups || {}
    if (!id || !ctx.ssrServer) {
      // 参数不合法
      throw createError({ statusCode: 400 })
    }
    return await getNode(ctx.ssrServer).resolveId(decodeURIComponent(id), importer ? decodeURIComponent(importer) : undefined).catch(() => null)
  }))

  // 添加获取模块代码的接口
  app.use('/module', defineEventHandler(async (event) => {
    const moduleId = decodeURI(event.path).substring(1)
    if (moduleId === '/' || !ctx.ssrServer) {
      // 路径无效
      throw createError({ statusCode: 400 })
    }
    if (isAbsolute(moduleId) && !isFileServingAllowed(ctx.ssrServer.config, moduleId)) {
      throw createError({ statusCode: 403 /* Restricted */ })
    }
    const node = getNode(ctx.ssrServer)
    const module = await node.fetchModule(moduleId).catch(async (err) => {
      const errorData = {
        code: 'VITE_ERROR',
        id: moduleId,
        stack: '',
        ...err,
      }

      // 如果是语法错误，尝试生成代码片段
      if (!errorData.frame && errorData.code === 'PARSE_ERROR') {
        errorData.frame = await node.transformModule(moduleId, 'web').then(({ code }) => `${err.message || ''}\n${code}`).catch(() => undefined)
      }
      throw createError({ data: errorData })
    })
    return module // 返回模块内容
  }))

  return app
}

// 定义 vite-node 服务的配置选项类型
export type ViteNodeServerOptions = {
  baseURL: string
  root: string
  entryPath: string
  base: string
}

export async function initViteNodeServer (ctx: ViteBuildContext) {
  // Serialize and pass vite-node runtime options
  // 构建并序列化 vite-node 的配置，供后续 SSR 使用
  const viteNodeServerOptions = {
    baseURL: `${ctx.nuxt.options.devServer.url}__nuxt_vite_node__`,
    root: ctx.nuxt.options.srcDir,
    entryPath: ctx.entry,
    base: ctx.ssrServer!.config.base || '/_nuxt/',
  } satisfies ViteNodeServerOptions
  // 设置为环境变量，供服务端运行时读取
  process.env.NUXT_VITE_NODE_OPTIONS = JSON.stringify(viteNodeServerOptions)

  // 写入 SSR 使用的 server.mjs 文件（用于动态导入 vite-node server）
  const serverResolvedPath = resolve(distDir, 'runtime/vite-node.mjs')
  const manifestResolvedPath = resolve(distDir, 'runtime/client.manifest.mjs')

  // 写入 manifest 文件（包含客户端资源）
  await writeFile(
    resolve(ctx.nuxt.options.buildDir, 'dist/server/server.mjs'),
    `export { default } from ${JSON.stringify(pathToFileURL(serverResolvedPath).href)}`,
  )
  await writeFile(
    resolve(ctx.nuxt.options.buildDir, 'dist/server/client.manifest.mjs'),
    `export { default } from ${JSON.stringify(pathToFileURL(manifestResolvedPath).href)}`,
  )
}
