// 导入类型 TransformerOptions，用于指定代码转换器的配置
import type { TransformerOptions } from 'unctx/transform'
// 导入创建 transformer 的函数，用于执行代码转换
import { createTransformer } from 'unctx/transform'
import { createUnplugin } from 'unplugin'

import { isJS, isVue } from '../utils'

// 定义一个特殊标记，标记代码已经被转换处理，防止重复转换
const TRANSFORM_MARKER = '/* _processed_nuxt_unctx_transform */\n'

// 插件配置的接口，支持 sourcemap 和 transformer 的自定义选项
interface UnctxTransformPluginOptions {
  sourcemap?: boolean  // 是否启用 source map（调试用）
  transformerOptions: TransformerOptions  // 转换器的配置项
}

// 导出一个名为 UnctxTransformPlugin 的插件函数，接收配置并返回 Unplugin 插件实例
export const UnctxTransformPlugin = (options: UnctxTransformPluginOptions) => createUnplugin(() => {
  // 基于传入的配置创建一个 transformer 实例（负责代码转换）
  const transformer = createTransformer(options.transformerOptions)
  // 返回符合 Unplugin 规范的插件对象
  return {
    name: 'unctx:transform',
    enforce: 'post',
    transformInclude (id) {
      // 指定插件要处理的文件类型（只有 JS 和 Vue 的 script/template 会被处理）
      return isVue(id, { type: ['template', 'script'] }) || isJS(id)
    },
    transform (code) {
      // TODO: needed for webpack - update transform in unctx/unplugin?
      // 兼容 webpack 的处理逻辑：如果已经处理过（带有标记）或不需要转换，则跳过
      if (code.startsWith(TRANSFORM_MARKER) || !transformer.shouldTransform(code)) { return }
      // 使用 transformer 执行实际的代码转换
      const result = transformer.transform(code)
      // 如果转换成功，返回新的代码和（可选的）source map
      if (result) {
        return {
          // 给转换后的代码加上标记，防止被重复转换
          code: TRANSFORM_MARKER + result.code,
          // 如果启用了 sourcemap，使用 magicString 生成 high-resolution map
          map: options.sourcemap
            ? result.magicString.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
})
