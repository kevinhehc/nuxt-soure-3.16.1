// 从 'unplugin' 库导入 `createUnplugin` 方法，用于创建一个 Vite/Rollup/Webpack 通用插件
import { createUnplugin } from 'unplugin'
// 引入 `magic-string`，用于对源代码做字符串层级的变换，同时保留 source map 支持
import MagicString from 'magic-string'
// 引入 Nuxt 类型定义
import type { Nuxt } from '@nuxt/schema'
// 从工具函数中引入判断是否为 Vue 文件的函数
import { isVue } from '../utils'

// 导出一个名为 AsyncContextInjectionPlugin 的插件工厂函数，接收 Nuxt 实例作为参数
export const AsyncContextInjectionPlugin = (nuxt: Nuxt) => createUnplugin(() => {
  // 插件定义对象
  return {
    // 插件名称
    name: 'nuxt:vue-async-context',
    // 用于判断当前文件是否应该被插件处理
    transformInclude (id) {
      // 只处理 `.vue` 文件中的 `template` 和 `script` 类型块
      return isVue(id, { type: ['template', 'script'] })
    },
    // 对匹配到的代码进行实际的转换处理
    transform (code) {
      // 如果代码中不包含 `_withAsyncContext`，说明不需要处理，直接返回
      if (!code.includes('_withAsyncContext')) {
        return
      }
      // 创建 MagicString 实例，用于对源代码进行编辑
      const s = new MagicString(code)
      // 向代码的最上方插入一行导入语句，确保 `_withAsyncContext` 正确引用
      s.prepend('import { withAsyncContext as _withAsyncContext } from "#app/composables/asyncContext";\n')
      // 替换已有的 `withAsyncContext as _withAsyncContext` 引用（可能重复），移除它避免重复导入
      s.replace(/withAsyncContext as _withAsyncContext,?/, '')
      // 如果代码发生了变更（即 MagicString 检测到了实际的变动）
      if (s.hasChanged()) {
        return {
          // 返回修改后的代码
          code: s.toString(),
          // 生成 source map（根据 Nuxt 是否启用 sourcemap 进行判断）
          map: nuxt.options.sourcemap.client || nuxt.options.sourcemap.server
            ? s.generateMap({ hires: true }) // hires: true 表示高精度的 source map
            : undefined,
        }
      }
    },
  }
})
