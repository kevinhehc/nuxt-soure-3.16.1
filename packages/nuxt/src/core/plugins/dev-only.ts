// 引入用于修改字符串的库，支持生成 source map
import MagicString from 'magic-string'
// 从 unplugin 创建可兼容 Vite/Webpack/Rollup 的通用插件工具
import { createUnplugin } from 'unplugin'
// ultrahtml 是一个 HTML 解析器，用于将 HTML 字符串转换为 AST
import { type Node, parse } from 'ultrahtml'
// 工具函数，用于判断某文件是否是 Vue 的 template 文件
import { isVue } from '../utils'

// 插件参数类型定义，可配置是否生成 source map
interface DevOnlyPluginOptions {
  sourcemap?: boolean
}

// 单个 dev-only 组件的正则匹配（非全局匹配，只判断是否存在）
const DEVONLY_COMP_SINGLE_RE = /<(?:dev-only|DevOnly|lazy-dev-only|LazyDevOnly)>[\s\S]*?<\/(?:dev-only|DevOnly|lazy-dev-only|LazyDevOnly)>/
// 所有 dev-only 组件的正则匹配（全局匹配，返回所有匹配项）
const DEVONLY_COMP_RE = /<(?:dev-only|DevOnly|lazy-dev-only|LazyDevOnly)>[\s\S]*?<\/(?:dev-only|DevOnly|lazy-dev-only|LazyDevOnly)>/g

// 定义并导出 DevOnly 插件函数
export const DevOnlyPlugin = (options: DevOnlyPluginOptions) => createUnplugin(() => {
  return {
    // 插件名称（方便调试）
    name: 'nuxt:server-devonly:transform',
    // 插件在 Vite 转换阶段的执行顺序（'pre' 表示最早执行）
    enforce: 'pre',
    // 定义插件要处理的文件类型
    transformInclude (id) {
      // 仅处理 .vue 文件中的 template 部分
      return isVue(id, { type: ['template'] })
    },
    // 转换逻辑本体
    transform (code) {
      // 如果代码中不包含任何 dev-only 组件，直接返回（性能优化）
      if (!DEVONLY_COMP_SINGLE_RE.test(code)) { return }

      // 创建 MagicString 实例以支持修改代码和生成 source map
      const s = new MagicString(code)
      // 遍历所有匹配到的 dev-only 组件片段
      for (const match of code.matchAll(DEVONLY_COMP_RE)) {
        // 解析 dev-only 组件为 AST
        const ast: Node = parse(match[0]).children[0]
        // 查找 dev-only 内部的 fallback 插槽模板
        const fallback: Node | undefined = ast.children?.find((n: Node) => n.name === 'template' && Object.values(n.attributes).includes('#fallback'))
        // 如果有 fallback，则提取 fallback 内容作为替代
        // 否则就什么都不替代（空字符串）
        const replacement = fallback ? match[0].slice(fallback.loc[0].end, fallback.loc[fallback.loc.length - 1].start) : ''
        // 用 fallback 替换原始 dev-only 标签
        s.overwrite(match.index!, match.index! + match[0].length, replacement)
      }

      // 如果代码被修改了，返回新的代码和 source map（如果需要）
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap
            ? s.generateMap({ hires: true }) // hires: 更高精度的 source map
            : undefined,
        }
      }
    },
  }
})
