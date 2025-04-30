import { pathToFileURL } from 'node:url'
import { createUnplugin } from 'unplugin'
import { parseQuery, parseURL } from 'ufo'
import type { StaticImport } from 'mlly'
import { findExports, findStaticImports, parseStaticImport } from 'mlly'
import MagicString from 'magic-string'
import { isAbsolute } from 'pathe'

import {
  ScopeTracker,
  type ScopeTrackerNode,
  getUndeclaredIdentifiersInFunction,
  isNotReferencePosition,
  parseAndWalk,
  walk,
  withLocations,
} from '../../core/utils/parse'
import { logger } from '../../utils'

// 用于处理 <script setup> 中使用的 definePageMeta() 宏。这段代码的主要目的是：
// 检测并提取页面元信息（如 definePageMeta({ layout: "custom" })）。
// 生成 __nuxt_page_meta 并导出。
// 处理开发模式下的 HMR 热更新。
// 适配 vite 和 webpack 构建工具。
// 处理无 definePageMeta 情况下的占位导出。

interface PageMetaPluginOptions {
  // dev: 是否为开发模式。
  // sourcemap: 是否生成 SourceMap（调试用）。
  // isPage: 用于判断某个文件是否为页面。
  // routesPath: 路由路径文件名（用于触发 HMR）。
  dev?: boolean
  sourcemap?: boolean
  isPage?: (file: string) => boolean
  routesPath?: string
}

// 用正则检测代码中是否包含 definePageMeta(...)，这表明当前文件是一个有元信息的页面组件。
const HAS_MACRO_RE = /\bdefinePageMeta\s*\(\s*/

// 当页面没有内容、也没定义 definePageMeta 时导出的默认空内容，表示页面无元数据。
const CODE_EMPTY = `
const __nuxt_page_meta = null
export default __nuxt_page_meta
`

// 开发模式下，空页面默认导出一个空对象 {}，便于调试。
const CODE_DEV_EMPTY = `
const __nuxt_page_meta = {}
export default __nuxt_page_meta
`

// 这是用于开发模式热更新（HMR）的逻辑：
// 对于 Vite，使用 import.meta.hot。
// 对于 Webpack，使用 import.meta.webpackHot。
// 如果模块变更，就合并新的 __nuxt_page_meta 内容；Webpack 错误时刷新页面。
const CODE_HMR = `
// Vite
if (import.meta.hot) {
  import.meta.hot.accept(mod => {
    Object.assign(__nuxt_page_meta, mod)
  })
}
// webpack
if (import.meta.webpackHot) {
  import.meta.webpackHot.accept((err) => {
    if (err) { window.location = window.location.href }
  })
}`

export const PageMetaPlugin = (options: PageMetaPluginOptions = {}) => createUnplugin(() => {
  return {
    name: 'nuxt:pages-macros-transform',
    enforce: 'post',
    transformInclude (id) {
      // 如果 URL query 中含有 ?macro=true，说明这个文件使用了宏（例如 definePageMeta()），插件就会处理它。
      return !!parseMacroQuery(id).macro
    },
    transform (code, id) {
      // 解析出 query，比如语言类型等。
      // 如果它不是 <script> 部分（例如是 <template>、<style>），就直接跳过。
      const query = parseMacroQuery(id)
      if (query.type && query.type !== 'script') { return }

      const s = new MagicString(code)
      function result () {
        if (s.hasChanged()) {
          return {
            code: s.toString(),
            map: options.sourcemap
              ? s.generateMap({ hires: true })
              : undefined,
          }
        }
      }

      // 检查代码中是否含有 definePageMeta() 宏。
      const hasMacro = HAS_MACRO_RE.test(code)

      // 提取静态 import 语句列表（用来后续分析变量来源）。
      const imports = findStaticImports(code)

      // [vite] Re-export any script imports
      // 如果发现导入了另一个 <script>，那就重写为 re-export（导出原始模块的默认导出）。
      // 这样可以避免重复处理，只处理最终的源脚本。
      const scriptImport = imports.find(i => parseMacroQuery(i.specifier).type === 'script')
      if (scriptImport) {
        const reorderedQuery = rewriteQuery(scriptImport.specifier)
        // Avoid using JSON.stringify which can add extra escapes to paths with non-ASCII characters
        const quotedSpecifier = getQuotedSpecifier(scriptImport.code)?.replace(scriptImport.specifier, reorderedQuery) ?? JSON.stringify(reorderedQuery)
        s.overwrite(0, code.length, `export { default } from ${quotedSpecifier}`)
        return result()
      }

      // [webpack] Re-export any exports from script blocks in the components
      // 和上面类似，但处理的是 export 的情况（Webpack 下的语法）。
      // 找到默认导出并重写为 re-export 的形式。
      const currentExports = findExports(code)
      for (const match of currentExports) {
        if (match.type !== 'default' || !match.specifier) {
          continue
        }

        const reorderedQuery = rewriteQuery(match.specifier)
        // Avoid using JSON.stringify which can add extra escapes to paths with non-ASCII characters
        const quotedSpecifier = getQuotedSpecifier(match.code)?.replace(match.specifier, reorderedQuery) ?? JSON.stringify(reorderedQuery)
        s.overwrite(0, code.length, `export { default } from ${quotedSpecifier}`)
        return result()
      }

      // 如果文件没有 definePageMeta、没有任何导出、也没有 __nuxt_page_meta：
      // 如果是空文件，追加一个默认导出并报错。
      // 如果有内容但没定义元信息，清空原代码，换成空导出。
      // 主要是保证 Nuxt 每个页面至少能导出一个页面元信息对象。
      if (!hasMacro && !code.includes('export { default }') && !code.includes('__nuxt_page_meta')) {
        if (!code) {
          s.append(options.dev ? (CODE_DEV_EMPTY + CODE_HMR) : CODE_EMPTY)
          const { pathname } = parseURL(decodeURIComponent(pathToFileURL(id).href))
          logger.error(`The file \`${pathname}\` is not a valid page as it has no content.`)
        } else {
          s.overwrite(0, code.length, options.dev ? (CODE_DEV_EMPTY + CODE_HMR) : CODE_EMPTY)
        }

        return result()
      }

      // 将所有静态导入（如 import foo from './a'）中使用的变量名加入 importMap。
      // 例如：foo → import foo from './a'。
      // 后续可以根据变量名反查它是从哪里导入的。
      const importMap = new Map<string, StaticImport>()
      const addedImports = new Set()
      for (const i of imports) {
        const parsed = parseStaticImport(i)
        for (const name of [
          parsed.defaultImport,
          ...Object.values(parsed.namedImports || {}),
          parsed.namespacedImport,
        ].filter(Boolean) as string[]) {
          importMap.set(name, i)
        }
      }

      // 判断一个变量是否是静态导入的。
      // 如果是，就添加它原始的 import 语句到最终输出中。
      function isStaticIdentifier (name: string | false): name is string {
        return !!(name && importMap.has(name))
      }

      function addImport (name: string | false) {
        if (!isStaticIdentifier(name)) { return }
        const importValue = importMap.get(name)!.code.trim()
        if (!addedImports.has(importValue)) {
          addedImports.add(importValue)
        }
      }

      // 用来收集所有 definePageMeta 依赖的变量声明。
      // 防止重复添加。
      const declarationNodes: ScopeTrackerNode[] = []
      const addedDeclarations = new Set<string>()

      function addDeclaration (node: ScopeTrackerNode) {
        const codeSectionKey = `${node.start}-${node.end}`
        if (addedDeclarations.has(codeSectionKey)) { return }
        addedDeclarations.add(codeSectionKey)
        declarationNodes.push(node)
      }

      /**
       * Adds an import or a declaration to the extracted code.
       * @param name The name of the import or declaration to add.
       * @param node The node that is currently being processed. (To detect self-references)
       */
      // 如果是静态导入变量：添加 import。
      // 否则：通过 ScopeTracker 找到变量声明节点，然后递归处理它。
      function addImportOrDeclaration (name: string, node?: ScopeTrackerNode) {
        if (isStaticIdentifier(name)) {
          addImport(name)
        } else {
          const declaration = scopeTracker.getDeclaration(name)
          /*
           Without checking for `declaration !== node`, we would end up in an infinite loop
           when, for example, a variable is declared and then used in its own initializer.
           (we shouldn't mask the underlying error by throwing a `Maximum call stack size exceeded` error)

           ```ts
           const a = { b: a }
           ```
           */
          if (declaration && declaration !== node) {
            processDeclaration(declaration)
          }
        }
      }

      // 解析 AST，同时构建作用域追踪结构（ScopeTracker）。
      // 用来查找每个变量在什么作用域中声明。
      // freeze() 表示不再添加新作用域了。
      const scopeTracker = new ScopeTracker({
        keepExitedScopes: true,
      })

      // 递归分析变量初始化表达式中使用到的变量。
      // 如果是 const x = { layout: myLayout }，它会继续分析 myLayout。
      // 还禁止使用 await（这是同步宏，不允许异步行为）。
      // 如果是函数（非箭头函数），提取未声明变量。
      function processDeclaration (scopeTrackerNode: ScopeTrackerNode | null) {
        if (scopeTrackerNode?.type === 'Variable') {
          addDeclaration(scopeTrackerNode)

          for (const decl of scopeTrackerNode.variableNode.declarations) {
            if (!decl.init) { continue }
            walk(decl.init, {
              enter: (node, parent) => {
                if (node.type === 'AwaitExpression') {
                  logger.error(`Await expressions are not supported in definePageMeta. File: '${id}'`)
                  throw new Error('await in definePageMeta')
                }
                if (
                  isNotReferencePosition(node, parent)
                  || node.type !== 'Identifier' // checking for `node.type` to narrow down the type
                ) { return }

                addImportOrDeclaration(node.name, scopeTrackerNode)
              },
            })
          }
        } else if (scopeTrackerNode?.type === 'Function') {
          // arrow functions are going to be assigned to a variable
          if (scopeTrackerNode.node.type === 'ArrowFunctionExpression') { return }
          const name = scopeTrackerNode.node.id?.name
          if (!name) { return }
          addDeclaration(scopeTrackerNode)

          const undeclaredIdentifiers = getUndeclaredIdentifiersInFunction(scopeTrackerNode.node)
          for (const name of undeclaredIdentifiers) {
            addImportOrDeclaration(name)
          }
        }
      }

      const ast = parseAndWalk(code, id + (query.lang ? '.' + query.lang : '.ts'), {
        scopeTracker,
      })

      scopeTracker.freeze()

      // 遍历整棵 AST。
      // 找到调用表达式（CallExpression），并且是 definePageMeta(...)。
      walk(ast, {
        scopeTracker,
        enter: (node) => {
          if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }
          if (!('name' in node.callee) || node.callee.name !== 'definePageMeta') { return }

          // 获取 definePageMeta 的第一个参数（即元信息对象）。
          // 使用 withLocations 标记 AST 节点的位置信息，用于后面提取源代码片段。
          const meta = withLocations(node.arguments[0])

          if (!meta) { return }

          // 记录 definePageMeta 调用所在的作用域，用于避免误提取局部变量。
          const definePageMetaScope = scopeTracker.getCurrentScope()

          // 遍历 definePageMeta 对象中的所有属性值。
          // 如果遇到标识符（变量名）：
          // 跳过本地变量（在 definePageMeta 的作用域内声明的变量）。
          // 如果是 import 的，添加 import。
          // 否则追踪声明并处理。
          walk(meta, {
            scopeTracker,
            enter (node, parent) {
              if (
                isNotReferencePosition(node, parent)
                || node.type !== 'Identifier' // checking for `node.type` to narrow down the type
              ) { return }

              const declaration = scopeTracker.getDeclaration(node.name)
              if (declaration) {
                // check if the declaration was made inside `definePageMeta` and if so, do not process it
                // (ensures that we don't hoist local variables in inline middleware, for example)
                if (
                  declaration.isUnderScope(definePageMetaScope)
                  // ensures that we compare the correct declaration to the reference
                  // (when in the same scope, the declaration must come before the reference, otherwise it must be in a parent scope)
                  && (scopeTracker.isCurrentScopeUnder(declaration.scope) || declaration.start < node.start)
                ) {
                  return
                }
              }

              if (isStaticIdentifier(node.name)) {
                addImport(node.name)
              } else if (declaration) {
                processDeclaration(declaration)
              }
            },
          })

          // 所有相关的 import 语句
          // 所需的变量声明
          // definePageMeta(...) 的原始代码片段
          // 拼接成一段代码，覆盖原有内容。
          // 并在开发模式中追加 HMR 支持。
          const importStatements = Array.from(addedImports).join('\n')

          const declarations = declarationNodes
            .sort((a, b) => a.start - b.start)
            .map(node => code.slice(node.start, node.end))
            .join('\n')

          const extracted = [
            importStatements,
            declarations,
            `const __nuxt_page_meta = ${code!.slice(meta.start, meta.end) || 'null'}\nexport default __nuxt_page_meta` + (options.dev ? CODE_HMR : ''),
          ].join('\n')

          s.overwrite(0, code.length, extracted.trim())
        },
      })

      // 如果最终没有任何有效变化（即没有 definePageMeta、没有导出、也没有生成代码），就生成一个默认导出（空 meta）。
      if (!s.hasChanged() && !code.includes('__nuxt_page_meta')) {
        s.overwrite(0, code.length, options.dev ? (CODE_DEV_EMPTY + CODE_HMR) : CODE_EMPTY)
      }

      return result()
    },
    vite: {
      // 当文件发生变更时，Vite 会调用这个钩子。
      // 如果：
      // 配置了 routesPath
      // 并且当前变更的文件是一个页面（通过 isPage(file) 判断）
      // 那么它会：
      // 获取当前页面对应的 macro module（加了 ?macro=true 的模块）
      // 获取虚拟路由模块 virtual:nuxt:<routesPath>（这是 Nuxt 动态生成的路由模块）
      // 将这些模块加入重新加载队列，从而触发热更新。
      handleHotUpdate: {
        order: 'post',
        handler: ({ file, modules, server }) => {
          if (options.routesPath && options.isPage?.(file)) {
            const macroModule = server.moduleGraph.getModuleById(file + '?macro=true')
            const routesModule = server.moduleGraph.getModuleById('virtual:nuxt:' + encodeURIComponent(options.routesPath))
            return [
              ...modules,
              ...macroModule ? [macroModule] : [],
              ...routesModule ? [routesModule] : [],
            ]
          }
        },
      },
    },
  }
})

// https://github.com/vuejs/vue-loader/pull/1911
// https://github.com/vitejs/vite/issues/8473
const QUERY_START_RE = /^\?/
const MACRO_RE = /&macro=true/
// 这个函数用于重写模块路径的查询字符串。
// 把原有的 query 替换为 ?macro=true&...，用于重新标记模块是宏模块（trigger Vite transform）。
function rewriteQuery (id: string) {
  return id.replace(/\?.+$/, r => '?macro=true&' + r.replace(QUERY_START_RE, '').replace(MACRO_RE, ''))
}

// 从路径中解析出 query（如语言类型、是否 script 等）。
// 如果 query 中包含 macro=true，就标记这个文件为宏模块。
function parseMacroQuery (id: string) {
  const { search } = parseURL(decodeURIComponent(isAbsolute(id) ? pathToFileURL(id).href : id).replace(/\?macro=true$/, ''))
  const query = parseQuery(search)
  if (id.includes('?macro=true')) {
    return { macro: 'true', ...query }
  }
  return query
}

// 用来从代码片段中提取出被引号包裹的 module 路径，例如 './foo'。
// 通常用于找出 import/export 的路径。
const QUOTED_SPECIFIER_RE = /(["']).*\1/
function getQuotedSpecifier (id: string) {
  return id.match(QUOTED_SPECIFIER_RE)?.[0]
}
