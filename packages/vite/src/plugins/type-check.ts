import MagicString from 'magic-string' // 导入 MagicString，这是一个用于字符串修改的库，能够保留源码映射
import type { Plugin } from 'vite' // 从 vite 包中引入 Plugin 类型，用于定义插件的结构

// 定义一个正则表达式，用于匹配 URL 中的查询参数部分，例如 "?v=1.0"
const QUERY_RE = /\?.+$/

// 用于在开发期间注入类型检查的运行时入口（通常与 vite-plugin-checker 搭配使用）
// 导出一个名为 TypeCheckPlugin 的函数，它返回一个 Vite 插件对象
// 接收一个可选的配置参数对象，支持 sourcemap 控制是否生成源码映射
export function TypeCheckPlugin (options: { sourcemap?: boolean } = {}): Plugin {
  // 定义一个变量 entry，用于后续记录构建输入的入口文件路径
  let entry: string
  // 返回一个符合 Vite 插件规范的对象
  return {
    // 插件的名称
    name: 'nuxt:type-check',
    // 在 Vite 配置解析完成后触发，用于读取最终的构建输入配置
    configResolved (config) {
      // 获取构建输入配置（rollup 的 input 字段）
      const input = config.build.rollupOptions.input
      // 如果 input 是一个对象，并且有 entry 字段，则将其记录为入口路径
      if (input && typeof input !== 'string' && !Array.isArray(input) && input.entry) {
        entry = input.entry
      }
    },
    // transform 钩子，在 Vite 处理每个模块时触发，可以修改代码内容
    transform (code, id) {
      // 去除查询参数后，判断当前模块是否为入口文件，如果不是则跳过
      if (id.replace(QUERY_RE, '') !== entry) { return }

      // 创建一个 MagicString 实例用于安全地修改源代码
      const s = new MagicString(code)

      // 在代码开头插入 import 语句，引入类型检查运行时入口文件
      s.prepend('import "/@vite-plugin-checker-runtime-entry";\n')

      // 返回修改后的代码和可选的源码映射（用于调试）
      return {
        // 修改后的代码
        code: s.toString(),
        // 若启用 sourcemap，则生成高精度映射
        map: options.sourcemap ? s.generateMap({ hires: true }) : undefined,
      }
    },
  }
}
