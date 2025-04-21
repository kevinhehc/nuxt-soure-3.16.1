import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import { hash } from 'ohash'

import { parseAndWalk, transform, withLocations } from '../../core/utils/parse'
import { isJS, isVue } from '../utils'

// 插件的逐行注释解析，包括对其功能、实现逻辑、以及背后的目的的解释。
// 导出一个名为 PrehydrateTransformPlugin 的函数，参数为 options，可传入 sourcemap 布尔值控制是否生成 source map
export function PrehydrateTransformPlugin (options: { sourcemap?: boolean } = {}) {
  // 返回一个由 unplugin 创建的 Vite 插件对象
  return createUnplugin(() => ({
    name: 'nuxt:prehydrate-transform',
    transformInclude (id) {
      // // 仅处理 JS 文件和包含 script 的 Vue 文件
      return isJS(id) || isVue(id, { type: ['script'] })
    },

    // 对符合条件的文件进行转换处理
    async transform (code, id) {
      // 如果源码中没有使用 `onPrehydrate`，跳过处理
      if (!code.includes('onPrehydrate(')) { return }

      // 创建 MagicString 实例用于源码字符串的可变操作
      const s = new MagicString(code)
      // 用于存储异步转换任务
      const promises: Array<Promise<any>> = []

      // 使用 parseAndWalk 遍历 AST 节点
      parseAndWalk(code, id, (node) => {
        // 如果不是调用表达式或者调用的不是标识符（Identifier），跳过
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') {
          return
        }
        // 仅处理 `onPrehydrate(...)` 这种函数调用
        if (node.callee.name === 'onPrehydrate') {
          // 提取第一个参数（应该是一个函数），并获取其起止位置
          const callback = withLocations(node.arguments[0])
          // 如果不存在，或者不是箭头函数或函数表达式，则跳过
          if (!callback) { return }
          if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression') { return }

          // 判断 callback 是否有参数（决定是否添加 hash）
          const needsAttr = callback.params.length > 0

          // 将函数包裹在 `forEach(...)` 结构中，调用 esbuild 的 transform API 编译并压缩
          const p = transform(`forEach(${code.slice(callback.start, callback.end)})`, { loader: 'ts', minify: true })
          // 添加到 promise 列表中，处理压缩结果
          promises.push(p.then(({ code: result }) => {
            // 移除 `forEach` 前缀和末尾的分号
            const cleaned = result.slice('forEach'.length).replace(/;\s+$/, '')
            // 构造替换参数数组，第一个参数是压缩后的函数体字符串
            const args = [JSON.stringify(cleaned)]
            // 如果函数有参数，添加一个根据压缩内容生成的短哈希值（前 10 位）
            if (needsAttr) {
              args.push(JSON.stringify(hash(result).slice(0, 10)))
            }
            // 替换原始函数定义为转换后的内容（字符串形式）
            s.overwrite(callback.start, callback.end, args.join(', '))
          }))
        }
      })

      // 等待所有转换完成，处理可能的错误
      await Promise.all(promises).catch((e) => {
        console.error(`[nuxt] Could not transform onPrehydrate in \`${id}\`:`, e)
      })

      // 如果代码有变更，返回更新后的代码和可选的 source map
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap
            ? s.generateMap({ hires: true }) // 高精度 map
            : undefined,
        }
      }
    },
  }))
}
