// 引入 strip-literal 工具，用于剥离字符串和注释内容，避免误判
import { stripLiteral } from 'strip-literal'
import MagicString from 'magic-string'
import { createUnplugin } from 'unplugin'
import { isJS, isVue } from '../utils'


// 类型定义：一个导入路径对应多个 composable 函数名
type ImportPath = string

// 插件的参数类型
interface TreeShakeComposablesPluginOptions {
  // 是否生成 source map，用于调试
  sourcemap?: boolean
  // 需要 tree-shake 的 composables 映射（路径 => 函数名列表）
  composables: Record<ImportPath, string[]>
}

// 插件函数定义，返回一个通用插件（兼容 Vite/Rollup/Webpack）
export const TreeShakeComposablesPlugin = (options: TreeShakeComposablesPluginOptions) => createUnplugin(() => {
  /**
   * @todo Use the options import-path to tree-shake composables in a safer way.
   */
  /**
   * TODO：将来应根据导入路径进行更安全的 tree-shaking。
   * 目前只是简单基于函数名替换，可能不够精确。
   */


  // 把所有路径下的 composable 函数名合并成一个扁平数组
  const composableNames = Object.values(options.composables).flat()


  // 构建用于匹配 composable 调用的正则表达式
  // 例如匹配 `useSomething(`，排除像 `useSomething() {` 这样的形式
  const regexp = `(^\\s*)(${composableNames.join('|')})(?=\\((?!\\) \\{))`
  const COMPOSABLE_RE = new RegExp(regexp, 'm') // 用于快速判断是否包含
  const COMPOSABLE_RE_GLOBAL = new RegExp(regexp, 'gm')// 用于实际全局匹配

  return {
    name: 'nuxt:tree-shake-composables:transform', // 插件名称
    enforce: 'post',
    transformInclude (id) {
      // 只处理 JS 文件和 Vue 文件中的 <script> 部分
      return isVue(id, { type: ['script'] }) || isJS(id)
    },
    transform (code) {
      // 如果代码中没有目标函数的调用，直接跳过
      if (!COMPOSABLE_RE.test(code)) { return }

      // 创建可变字符串对象，用于替换代码段
      const s = new MagicString(code)
      // 去除字符串和注释，防止 false positives
      const strippedCode = stripLiteral(code)
      // 匹配所有目标函数调用
      for (const match of strippedCode.matchAll(COMPOSABLE_RE_GLOBAL)) {
        // 将匹配的函数调用前加上 `false && /*@__PURE__*/`，供 tree-shaker 去除
        // match[1] 是缩进空格，match[2] 是函数名
        s.overwrite(match.index!, match.index! + match[0].length, `${match[1]} false && /*@__PURE__*/ ${match[2]}`)  // 匹配起始位置  // 匹配结束位置  // 替换内容
      }

      // 如果字符串发生了变更，返回替换后的代码和映射（如果启用了 sourcemap）
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap
            ? s.generateMap({ hires: true })  // 高精度 source map
            : undefined,
        }
      }
    },
  }
})
