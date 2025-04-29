import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import type { Component } from 'nuxt/schema'
import { parseAndWalk, withLocations } from '../../core/utils/parse'

import { SX_RE, isVue } from '../../core/utils'

// 每个自动导入的 Vue 组件，默认会有一个 __name 属性（供调试用）。
// 这个插件会把 __name 改成组件的 PascalCase 名字，而不是简单用文件名。
// 如果代码里原本没有 __name（比如没有 setup 函数的组件），插件就会强制加上。
// 最后如果有改动，还会生成对应的 sourcemap。
// 为什么要这样做？
// 让组件在 Vue DevTools、错误日志、警告提示中显示更规范的名字（更好调试！）
// 避免因为文件名和组件实际名字不同而造成混淆。

// 定义接口 NameDevPluginOptions，要求提供 sourcemap 开关和一个 getComponents 函数
interface NameDevPluginOptions {
  sourcemap: boolean
  // 返回组件数组
  getComponents: () => Component[]
}

// 正则表达式，用于从文件路径中提取文件名（去掉扩展名）
const FILENAME_RE = /([^/\\]+)\.\w+$/
/**
 * Set the default name of components to their PascalCase name
 * 将组件默认的名字设置为 PascalCase 格式
 */
export const ComponentNamePlugin = (options: NameDevPluginOptions) => createUnplugin(() => {
  return {
    // 插件名字
    name: 'nuxt:component-name-plugin',
    // 设置为 post 阶段，确保是在其他插件处理后执行
    enforce: 'post',
    // 判断是否要处理这个文件
    transformInclude (id) {
      /* v8 ignore next 2 */
      return isVue(id) || !!id.match(SX_RE)
      // isVue(id)：检查是不是 .vue 文件
      // SX_RE：检查是不是某些特定后缀（可能是 .setup.vue 这类）
    },

    // 正式进行 transform
    transform (code, id) {
      // 从路径中提取出文件名（去掉扩展名）
      const filename = id.match(FILENAME_RE)?.[1]
      // 如果拿不到文件名，直接跳过
      if (!filename) {
        return
      }

      // 在注册的组件列表中找到当前处理的组件
      const component = options.getComponents().find(c => c.filePath === id)

      // 如果找不到对应组件，也跳过
      if (!component) {
        return
      }

      // 创建一个新的正则，用来找 `__name: 'xxx'` 这样的代码
      const NAME_RE = new RegExp(`__name:\\s*['"]${filename}['"]`)
      // 使用 MagicString 工具，可以安全地修改字符串（保留位置信息）
      const s = new MagicString(code)
      // 尝试替换默认的 __name 为 PascalCase 格式的名字
      s.replace(NAME_RE, `__name: ${JSON.stringify(component.pascalName)}`)

      // Without setup function, vue compiler does not generate __name
      // 特殊情况：如果组件里没有 setup 函数，Vue 编译器不会生成 __name
      if (!s.hasChanged()) {
        // 手动处理：找到 export default 的对象，加上 __name
        parseAndWalk(code, id, function (node) {
          if (node.type !== 'ExportDefaultDeclaration') {
            return
          }

          const { start, end } = withLocations(node.declaration)
          // 将 export default 的内容用 Object.assign 包一层，补上 __name 属性
          s.overwrite(start, end, `Object.assign(${code.slice(start, end)}, { __name: ${JSON.stringify(component.pascalName)} })`)
          this.skip()
        })
      }

      // 如果修改过内容，返回新的 code 和 sourcemap
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap
            /* v8 ignore next */
            ? s.generateMap({ hires: true })// 如果需要 sourcemap，生成高精度的 map
            : undefined,
        }
      }
    },
  }
})
