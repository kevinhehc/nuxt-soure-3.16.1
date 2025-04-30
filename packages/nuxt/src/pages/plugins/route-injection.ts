import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import type { Nuxt } from '@nuxt/schema'
import { stripLiteral } from 'strip-literal'
import { isVue } from '../../core/utils'

// 在模板或脚本中注入安全的 $route 引用，避免 SSR 报错或访问 undefined。

// INJECTION_RE_TEMPLATE：匹配 Vue 模板中 $route 的访问（编译后形式为 _ctx.$route）。
// INJECTION_RE_SCRIPT：匹配 <script> 中 this.$route 的访问。
// INJECTION_SINGLE_RE：统一判断是否需要处理。
const INJECTION_RE_TEMPLATE = /\b_ctx\.\$route\b/g
const INJECTION_RE_SCRIPT = /\bthis\.\$route\b/g

const INJECTION_SINGLE_RE = /\bthis\.\$route\b|\b_ctx\.\$route\b/

// 创建一个名为 nuxt:route-injection-plugin 的 Unplugin 插件。
// 位置为 post，确保是在模板/脚本已处理完之后执行（此时 $route 已呈现为 _ctx.$route 或 this.$route）。
export const RouteInjectionPlugin = (nuxt: Nuxt) => createUnplugin(() => {
  return {
    name: 'nuxt:route-injection-plugin',
    enforce: 'post',
    transformInclude (id) {
      // 判断当前文件是否为 .vue 文件的 <template> 或 <script> 部分。
      // 如果是，就执行 transform 逻辑。
      return isVue(id, { type: ['template', 'script'] })
    },
    transform (code) {
      // 首先检查是否使用 $route。
      // 并排除已经被替换过的代码（避免重复注入）。
      if (!INJECTION_SINGLE_RE.test(code) || code.includes('_ctx._.provides[__nuxt_route_symbol') || code.includes('this._.provides[__nuxt_route_symbol')) { return }

      // 使用 MagicString 进行代码替换。
      // stripLiteral() 是 Nuxt 内部函数，用于去除字符串/注释，使正则更可靠，不会误匹配。
      let replaced = false
      const s = new MagicString(code)
      const strippedCode = stripLiteral(code)

      // Local helper function for regex-based replacements using `strippedCode`
      // 遍历匹配到的所有 $route，在原始代码中替换为“安全访问形式”。
      // ||= 是逻辑或赋值（如果任一匹配成功则标记为 replaced）。
      const replaceMatches = (regExp: RegExp, replacement: string) => {
        for (const match of strippedCode.matchAll(regExp)) {
          const start = match.index!
          const end = start + match[0].length
          s.overwrite(start, end, replacement)
          replaced ||= true
        }
      }

      // 将 _ctx.$route 替换为：
      // _ctx._.provides[__nuxt_route_symbol] || _ctx.$route
      // 同理，this.$route 替换为：
      // this._.provides[__nuxt_route_symbol] || this.$route
      // 这两个写法的意义是：优先使用 Nuxt 提供的 PageRouteSymbol，否则 fallback 到原始的 $route。
      // handles `$route` in template
      replaceMatches(INJECTION_RE_TEMPLATE, '(_ctx._.provides[__nuxt_route_symbol] || _ctx.$route)')

      // handles `this.$route` in script
      replaceMatches(INJECTION_RE_SCRIPT, '(this._.provides[__nuxt_route_symbol] || this.$route)')

      if (replaced) {
        // 如果执行了替换操作，就插入一行 import { PageRouteSymbol }，用于访问注入式的路由对象。
        s.prepend('import { PageRouteSymbol as __nuxt_route_symbol } from \'#app/components/injections\';\n')
      }

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: nuxt.options.sourcemap.client || nuxt.options.sourcemap.server
            ? s.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
})
