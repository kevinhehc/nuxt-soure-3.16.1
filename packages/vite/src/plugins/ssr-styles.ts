import { pathToFileURL } from 'node:url' // 从 Node.js 的 url 模块导入 pathToFileURL，用于将文件路径转换为 file URL。
import type { Plugin } from 'vite'  // 从 Vite 中导入 Plugin 类型，用于定义插件。
import { dirname, relative } from 'pathe'  // 从 pathe 模块导入 dirname 和 relative，处理文件路径。
import { genImport, genObjectFromRawEntries } from 'knitwork' // 从 knitwork 导入用于生成代码的辅助函数。
import { filename as _filename } from 'pathe/utils'  // 从 pathe/utils 导入 filename 并重命名为 _filename，用于提取文件名。
import { parseQuery, parseURL } from 'ufo' // 从 ufo 模块导入 URL 和查询参数解析器。
import type { Component } from '@nuxt/schema' // 从 Nuxt schema 中导入组件类型定义。
import MagicString from 'magic-string'  // 导入 MagicString，用于对源代码进行字符串变换。
import { findStaticImports } from 'mlly'  // 导入用于查找静态导入语句的函数。

import { isCSS, isVue } from '../utils'  // 导入判断是否为 CSS 或 Vue 文件的辅助函数。

// 定义 SSR 样式插件的配置接口
interface SSRStylePluginOptions {
  srcDir: string // 源代码目录
  chunksWithInlinedCSS: Set<string> // 已内联 CSS 的 chunk 集合
  shouldInline?: ((id?: string) => boolean) | boolean  // 判断是否需要内联样式
  components: Component[] // 所有组件的列表
  clientCSSMap: Record<string, Set<string>> // 客户端模块对应的 CSS 文件映射
  entry: string // 入口文件 ID
  globalCSS: string[] // 全局 CSS 文件列表
  mode: 'server' | 'client' // 构建模式：服务端或客户端
}

// 正则表达式，匹配支持的源码文件（Vue、JS、TS）
const SUPPORTED_FILES_RE = /\.(?:vue|(?:[cm]?j|t)sx?)$/

// 定义插件函数
// 在 Nuxt 3 开发模式下（dev + ssr: true），
// 收集服务器渲染过程中用到的 CSS，
// 并且在返回的 SSR HTML 里 动态插入 <link> 标签，
// 这样服务器渲染出来的页面也有完整的 CSS 样式。

// 可以总结成这样：
// 在服务器处理请求时（renderToString），
// ssrStylesPlugin 分析当前页面用到了哪些 CSS 模块，
// 把这些 CSS 的 URL 记录下来，
// 在最终生成的 SSR HTML 里面，
// 插入对应的 <link rel="stylesheet" href="..."> 标签。
// 这样，浏览器收到的 HTML 页面就已经有完整样式了！
// 页面不会白屏！
// 样式即时生效！
export function ssrStylesPlugin (options: SSRStylePluginOptions): Plugin {
  // 记录每个模块的 CSS 引用
  const cssMap: Record<string, { files: string[], inBundle?: boolean }> = {}
  const idRefMap: Record<string, string> = {}

  // 将路径转为相对 srcDir 的路径
  const relativeToSrcDir = (path: string) => relative(options.srcDir, path)

  // 缓存已发出警告的文件，避免重复
  const warnCache = new Set<string>()
  // 筛选出需要作为岛屿（island）组件的 Vue 组件
  const islands = options.components.filter(component =>
    component.island ||
    // .server components without a corresponding .client component will need to be rendered as an island
    (component.mode === 'server' && !options.components.some(c => c.pascalName === component.pascalName && c.mode === 'client')),
  )

  return {
    // 插件名称
    name: 'ssr-styles',
    resolveId: {
      // 插件钩子的调用顺序
      order: 'pre',
      async handler (id, importer, _options) {
        // We want to remove side effects (namely, emitting CSS) from `.vue` files and explicitly imported `.css` files
        // but only as long as we are going to inline that CSS.
        // 如果不需要内联样式则跳过
        if ((options.shouldInline === false || (typeof options.shouldInline === 'function' && !options.shouldInline(importer)))) {
          return
        }

        // 对特定模块进行处理
        if (id === '#build/css' || id.endsWith('.vue') || isCSS(id)) {
          const res = await this.resolve(id, importer, { ..._options, skipSelf: true })
          if (res) {
            return {
              ...res,
              // 禁止副作用（例如 CSS 插入）
              moduleSideEffects: false,
            }
          }
        }
      },
    },
    // 打包结束阶段触发
    generateBundle (outputOptions) {
      // 客户端模式不处理
      if (options.mode === 'client') { return }

      // 存储已生成的文件
      const emitted: Record<string, string> = {}
      // 没有 CSS 或未打包的不处理
      for (const [file, { files, inBundle }] of Object.entries(cssMap)) {
        // File has been tree-shaken out of build (or there are no styles to inline)
        if (!files.length || !inBundle) { continue }
        // 获取文件名
        const fileName = filename(file)
        const base = typeof outputOptions.assetFileNames === 'string'
          ? outputOptions.assetFileNames
          : outputOptions.assetFileNames({
              type: 'asset',
              name: `${fileName}-styles.mjs`,
              names: [`${fileName}-styles.mjs`],
              originalFileName: `${fileName}-styles.mjs`,
              originalFileNames: [`${fileName}-styles.mjs`],
              source: '',
            })

        const baseDir = dirname(base)

        // 生成包含样式导入的模块
        emitted[file] = this.emitFile({
          type: 'asset',
          name: `${fileName}-styles.mjs`,
          source: [
            ...files.map((css, i) => `import style_${i} from './${relative(baseDir, this.getFileName(css))}';`),
            `export default [${files.map((_, i) => `style_${i}`).join(', ')}]`,
          ].join('\n'),
        })
      }

      for (const key in emitted) {
        // Track the chunks we are inlining CSS for so we can omit including links to the .css files
        options.chunksWithInlinedCSS.add(key)
      }

      // TODO: remove css from vite preload arrays

      // 生成一个总样式模块文件 styles.mjs，导出所有样式模块的懒加载函数
      this.emitFile({
        type: 'asset',
        fileName: 'styles.mjs',
        originalFileName: 'styles.mjs',
        source:
          [
            'const interopDefault = r => r.default || r || []',
            `export default ${genObjectFromRawEntries(
              Object.entries(emitted).map(([key, value]) => [key, `() => import('./${this.getFileName(value)}').then(interopDefault)`]) as [string, string][],
            )}`,
          ].join('\n'),
      })
    },
    // 对 chunk 进行处理
    renderChunk (_code, chunk) {
      // 判断是否为入口模块
      const isEntry = chunk.facadeModuleId === options.entry
      if (isEntry) {
        options.clientCSSMap[chunk.facadeModuleId!] ||= new Set()
      }
      for (const moduleId of [chunk.facadeModuleId, ...chunk.moduleIds].filter(Boolean) as string[]) {
        // 'Teleport' CSS chunks that made it into the bundle on the client side
        // to be inlined on server rendering
        if (options.mode === 'client') {
          const moduleMap = options.clientCSSMap[moduleId] ||= new Set()
          if (isCSS(moduleId)) {
            // Vue files can (also) be their own entrypoints as they are tracked separately
            if (isVue(moduleId)) {
              moduleMap.add(moduleId)
              const parent = moduleId.replace(/\?.+$/, '')
              const parentMap = options.clientCSSMap[parent] ||= new Set()
              parentMap.add(moduleId)
            }
            // This is required to track CSS in entry chunk
            if (isEntry && chunk.facadeModuleId) {
              const facadeMap = options.clientCSSMap[chunk.facadeModuleId] ||= new Set()
              facadeMap.add(moduleId)
            }
          }
          continue
        }

        const relativePath = relativeToSrcDir(moduleId)
        if (relativePath in cssMap) {
          cssMap[relativePath]!.inBundle = cssMap[relativePath]!.inBundle ?? ((isVue(moduleId) && !!relativeToSrcDir(moduleId)) || isEntry)
        }
      }

      return null
    },

    // 对源代码进行转换
    async transform (code, id) {
      if (options.mode === 'client') {
        // We will either teleport global CSS to the 'entry' chunk on the server side
        // or include it here in the client build so it is emitted in the CSS.
        // 客户端模式下，在入口模块注入全局样式
        if (id === options.entry && (options.shouldInline === true || (typeof options.shouldInline === 'function' && options.shouldInline(id)))) {
          const s = new MagicString(code)
          const idClientCSSMap = options.clientCSSMap[id] ||= new Set()
          if (!options.globalCSS.length) { return }

          for (const file of options.globalCSS) {
            const resolved = await this.resolve(file) ?? await this.resolve(file, id)
            const res = await this.resolve(file + '?inline&used') ?? await this.resolve(file + '?inline&used', id)
            if (!resolved || !res) {
              if (!warnCache.has(file)) {
                warnCache.add(file)
                this.warn(`[nuxt] Cannot extract styles for \`${file}\`. Its styles will not be inlined when server-rendering.`)
              }
              s.prepend(`${genImport(file)}\n`)
              continue
            }
            idClientCSSMap.add(resolved.id)
          }
          if (s.hasChanged()) {
            return {
              code: s.toString(),
              map: s.generateMap({ hires: true }),
            }
          }
        }
        return
      }

      // 解析文件路径和查询参数
      const { pathname, search } = parseURL(decodeURIComponent(pathToFileURL(id).href))

      // 非 island 组件或无样式映射则跳过
      if (!(id in options.clientCSSMap) && !islands.some(c => c.filePath === pathname)) { return }

      const query = parseQuery(search)
      if (query.macro || query.nuxt_component) { return }

      // 如果不是岛屿组件且不应内联，跳过
      if (!islands.some(c => c.filePath === pathname)) {
        if (options.shouldInline === false || (typeof options.shouldInline === 'function' && !options.shouldInline(id))) { return }
      }

      const relativeId = relativeToSrcDir(id)
      const idMap = cssMap[relativeId] ||= { files: [] }

      const emittedIds = new Set<string>()

      let styleCtr = 0
      const ids = options.clientCSSMap[id] || []
      for (const file of ids) {
        const resolved = await this.resolve(file) ?? await this.resolve(file, id)
        const res = await this.resolve(file + '?inline&used') ?? await this.resolve(file + '?inline&used', id)
        if (!resolved || !res) {
          if (!warnCache.has(file)) {
            warnCache.add(file)
            this.warn(`[nuxt] Cannot extract styles for \`${file}\`. Its styles will not be inlined when server-rendering.`)
          }
          continue
        }
        if (emittedIds.has(file)) { continue }
        const ref = this.emitFile({
          type: 'chunk',
          name: `${filename(id)}-styles-${++styleCtr}.mjs`,
          id: file + '?inline&used',
        })

        idRefMap[relativeToSrcDir(file)] = ref
        idMap.files.push(ref)
      }

      if (!SUPPORTED_FILES_RE.test(pathname)) { return }

      for (const i of findStaticImports(code)) {
        const { type } = parseQuery(i.specifier)
        if (type !== 'style' && !i.specifier.endsWith('.css')) { continue }

        const resolved = await this.resolve(i.specifier, id)
        if (!resolved) { continue }
        if (!(await this.resolve(resolved.id + '?inline&used'))) {
          if (!warnCache.has(resolved.id)) {
            warnCache.add(resolved.id)
            this.warn(`[nuxt] Cannot extract styles for \`${i.specifier}\`. Its styles will not be inlined when server-rendering.`)
          }
          continue
        }

        if (emittedIds.has(resolved.id)) { continue }
        const ref = this.emitFile({
          type: 'chunk',
          name: `${filename(id)}-styles-${++styleCtr}.mjs`,
          id: resolved.id + '?inline&used',
        })

        idRefMap[relativeToSrcDir(resolved.id)] = ref
        idMap.files.push(ref)
      }
    },
  }
}

// 提取文件名，去除查询参数
function filename (name: string) {
  return _filename(name.replace(/\?.+$/, ''))
}
