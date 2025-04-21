// 引入 Node.js 的 URL 工具
import { pathToFileURL } from 'node:url'
// 创建 unplugin 插件的工具
import { createUnplugin } from 'unplugin'
// 路径工具函数
import { isAbsolute, relative } from 'pathe'
// 处理字符串修改（用于生成新的源码）
import MagicString from 'magic-string'
// 用于生成哈希值
import { hash } from 'ohash'
// URL 工具（解析 URL 和 query）
import { parseQuery, parseURL } from 'ufo'
// 正则转义工具
import escapeRE from 'escape-string-regexp'
// 解析 import 的工具
import { findStaticImports, parseStaticImport } from 'mlly'
// AST 分析工具：作用域追踪、解析与遍历
import { ScopeTracker, parseAndWalk, walk } from '../utils/parse'

// 判断字符串或正则是否匹配
import { matchWithStringOrRegex } from '../utils/plugins'

/*
一、原始代码（开发者写的）
// pages/index.vue
<script setup>
const { data } = await useAsyncData(() => $fetch('/api/posts'))
</script>
在这个例子中，useAsyncData 只传了一个函数，没有传 key。这可能会导致 Nuxt 无法缓存或识别这次调用的唯一性。

二、插件处理后的代码（编译时自动添加）
<script setup>
const { data } = await useAsyncData(() => $fetch('/api/posts'), '$8d1f9a3a7e')
</script>
插件帮你自动加了第二个参数：'$8d1f9a3a7e'，这是一个通过当前文件路径 + 位置 + 计数器生成的唯一哈希值。

三、这个 key：

1.是确定性的，每次构建都是一样的；
2.是唯一的，避免不同组件里多个 useAsyncData 冲突；
3.是开发者无需显式写出来的，提高 DX（开发体验）。
 */

// 插件配置项接口定义
interface ComposableKeysOptions {
  // 是否生成 source map
  sourcemap: boolean
  // 项目根目录
  rootDir: string
  // 支持的组合式函数
  composables: Array<{ name: string, source?: string | RegExp, argumentLength: number }>
}

// 支持的字符串类型（用于参数类型判断）
const stringTypes: Array<string | undefined> = ['Literal', 'TemplateLiteral']
// 排除 Nuxt 内部模块
const NUXT_LIB_RE = /node_modules\/(?:nuxt|nuxt3|nuxt-nightly)\//
// 支持的文件类型
const SUPPORTED_EXT_RE = /\.(?:m?[jt]sx?|vue)/
// 提取 script 标签的内容
const SCRIPT_RE = /(?<=<script[^>]*>)[\s\S]*?(?=<\/script>)/i

export const ComposableKeysPlugin = (options: ComposableKeysOptions) => createUnplugin(() => {
  // 存储每个组合函数的元信息
  const composableMeta: Record<string, any> = {}
  // 参数长度集合
  const composableLengths = new Set<number>()
  // 所有组合函数名
  const keyedFunctions = new Set<string>()
  for (const { name, ...meta } of options.composables) {
    composableMeta[name] = meta
    keyedFunctions.add(name)
    composableLengths.add(meta.argumentLength)
  }

  // 记录所有组合函数中参数的最大长度
  const maxLength = Math.max(...composableLengths)
  // 构建正则，用于匹配这些函数名
  const KEYED_FUNCTIONS_RE = new RegExp(`\\b(${[...keyedFunctions].map(f => escapeRE(f)).join('|')})\\b`)

  return {
    name: 'nuxt:composable-keys',
    // 在 transform 流程的后期执行
    enforce: 'post',
    transformInclude (id) {
      const { pathname, search } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return !NUXT_LIB_RE.test(pathname) && // 排除 Nuxt 核心包
        SUPPORTED_EXT_RE.test(pathname) && // 文件类型合法
        parseQuery(search).type !== 'style' && // 不是 CSS
        !parseQuery(search).macro // 不是宏处理文件
    },
    // 添加唯一 key
    transform (code, id) {
      if (!KEYED_FUNCTIONS_RE.test(code)) { return }
      // 提取 <script> 中的 JS 代码
      const { 0: script = code, index: codeIndex = 0 } = code.match(SCRIPT_RE) || { index: 0, 0: code }
      const s = new MagicString(code)
      // https://github.com/unjs/unplugin/issues/90
      let imports: Set<string> | undefined
      let count = 0
      const relativeID = isAbsolute(id) ? relative(options.rootDir, id) : id
      const { pathname: relativePathname } = parseURL(relativeID)

      // To handle variables hoisting we need a pre-pass to collect variable and function declarations with scope info.
      // 首先扫描变量和函数定义（用于判断作用域）
      const scopeTracker = new ScopeTracker({
        keepExitedScopes: true,
      })
      const ast = parseAndWalk(script, id, {
        scopeTracker,
      })

      scopeTracker.freeze()

      // 识别组合函数调用并插入 key
      walk(ast, {
        scopeTracker,
        enter (node) {
          if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }
          const name = node.callee.name
          if (!name || !keyedFunctions.has(name) || node.arguments.length >= maxLength) { return }

          // 检测导入的函数名
          imports ||= detectImportNames(script, composableMeta)
          if (imports.has(name)) { return }

          const meta = composableMeta[name]

          const declaration = scopeTracker.getDeclaration(name)

          // 如果不是导入的，而是本地函数定义，要看路径是否匹配
          if (declaration && declaration.type !== 'Import') {
            let skip = true
            if (meta.source) {
              skip = !matchWithStringOrRegex(relativePathname, meta.source)
            }

            if (skip) { return }
          }

          // 参数数目足够则跳过
          if (node.arguments.length >= meta.argumentLength) { return }

          // 特定函数需要额外判断参数是否为字符串
          switch (name) {
            case 'useState':
              if (stringTypes.includes(node.arguments[0]?.type)) { return }
              break

            case 'useFetch':
            case 'useLazyFetch':
              if (stringTypes.includes(node.arguments[1]?.type)) { return }
              break

            case 'useAsyncData':
            case 'useLazyAsyncData':
              if (stringTypes.includes(node.arguments[0]?.type) || stringTypes.includes(node.arguments[node.arguments.length - 1]?.type)) { return }
              break
          }

          // TODO: Optimize me (https://github.com/nuxt/framework/pull/8529)
          // 生成新的参数：唯一哈希 key
          const newCode = code.slice(codeIndex + (node as any).start, codeIndex + (node as any).end - 1).trim()
          const endsWithComma = newCode[newCode.length - 1] === ','

          s.appendLeft(
            codeIndex + (node as any).end - 1,
            (node.arguments.length && !endsWithComma ? ', ' : '') + '\'$' + hash(`${relativeID}-${++count}`).slice(0, 10) + '\'',
          )
        },
      })
      if (s.hasChanged()) {
        // 返回修改后的代码和 map
        return {
          code: s.toString(),
          map: options.sourcemap
            ? s.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
})

// 检测组合函数是否是导入的
const NUXT_IMPORT_RE = /nuxt|#app|#imports/

export function detectImportNames (code: string, composableMeta: Record<string, { source?: string | RegExp }>) {
  const names = new Set<string>()
  function addName (name: string, specifier: string) {
    const source = composableMeta[name]?.source
    if (source && matchWithStringOrRegex(specifier, source)) {
      return
    }
    names.add(name)
  }

  for (const i of findStaticImports(code)) {
    if (NUXT_IMPORT_RE.test(i.specifier)) { continue }

    const { namedImports = {}, defaultImport, namespacedImport } = parseStaticImport(i)
    for (const name in namedImports) {
      addName(namedImports[name]!, i.specifier)
    }
    if (defaultImport) {
      addName(defaultImport, i.specifier)
    }
    if (namespacedImport) {
      addName(namespacedImport, i.specifier)
    }
  }
  return names
}
