import { runInNewContext } from 'node:vm'
import type { NuxtPage } from '@nuxt/schema'
import type { NitroRouteConfig } from 'nitropack'
import { normalize } from 'pathe'

import { getLoader } from '../core/utils'
import { parseAndWalk } from '../core/utils/parse'
import { extractScriptContent, pathToNitroGlob } from './utils'

const ROUTE_RULE_RE = /\bdefineRouteRules\(/
const ruleCache: Record<string, NitroRouteConfig | null> = {}

// 提取一个页面文件中调用的 defineRouteRules({...}) 配置
export function extractRouteRules (code: string, path: string): NitroRouteConfig | null {

  // 利用缓存提升性能。
  // 如果源码中没有 defineRouteRules 字样，直接跳过。
  if (code in ruleCache) {
    return ruleCache[code] || null
  }
  if (!ROUTE_RULE_RE.test(code)) { return null }

  let rule: NitroRouteConfig | null = null

  // 加载器判断 & 提取 <script> 内容
  const loader = getLoader(path)
  if (!loader) { return null }

  // .vue 文件需要提取 <script> 块
  // 普通 .ts, .js, .mjs 文件直接读取
  const contents = loader === 'vue' ? extractScriptContent(code) : [{ code, loader }]


  for (const script of contents) {
    if (rule) { break }

    code = script?.code || code

    // 使用 AST 遍历找到调用 defineRouteRules({...}) 的表达式，并将其转换为字符串，再在沙箱环境中用 JSON.stringify(...) 动态执行，解析出对象。
    // 安全限制：只能用 JSON 结构，不能有函数、变量、逻辑。
    parseAndWalk(code, 'file.' + (script?.loader || 'ts'), (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }
      if (node.callee.name === 'defineRouteRules') {
        const rulesString = code.slice(node.start, node.end)
        try {
          rule = JSON.parse(runInNewContext(rulesString.replace('defineRouteRules', 'JSON.stringify'), {}))
        } catch {
          throw new Error('[nuxt] Error parsing route rules. They should be JSON-serializable.')
        }
      }
    })
  }

  // 缓存 + 返回
  ruleCache[code] = rule
  return rule
}

// 这个函数将页面组件（来自 pages/）转换为 [路径 → nitro glob] 的映射表。
// getMappedPages(pages) 会根据页面树生成一个：
// {
//   '/absolute/path/to/pages/index.vue': '/',
//   '/absolute/path/to/pages/blog/[slug].vue': '/blog/:slug',
//   ...
// }
export function getMappedPages (pages: NuxtPage[], paths = {} as { [absolutePath: string]: string | null }, prefix = '') {
  for (const page of pages) {
    if (page.file) {
      const filename = normalize(page.file)
      // 并转换为 glob 格式：
      // /about → /about
      // /blog/[slug].vue → /blog/**
      paths[filename] = pathToNitroGlob(prefix + page.path)
    }
    if (page.children) {
      getMappedPages(page.children, paths, page.path + '/')
    }
  }
  return paths
}
