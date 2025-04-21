import MagicString from 'magic-string'
import type { Plugin } from 'vite'

const QUERY_RE = /\?.+$/

// 用于在构建时给你的 入口文件（通常是 main.ts 或 entry.js）自动注入 modulepreload-polyfill 的导入语句。
// 为确保旧浏览器兼容性的一个细节处理。
// sourcemap: 是否生成 sourcemap
// entry: 要处理的入口文件路径
export function ModulePreloadPolyfillPlugin (options: { sourcemap: boolean, entry: string }): Plugin {
  let isDisabled = false
  return {
    name: 'nuxt:module-preload-polyfill',
    configResolved (config) {
      // 在 Vite 的构建配置中，如果显式关闭了 modulePreload 或 modulePreload.polyfill，插件会自动禁用。
      isDisabled = config.build.modulePreload === false || config.build.modulePreload.polyfill === false
    },
    transform (code, id) {
      // （排除带 query 参数的情况，如 main.js?vue&type=script）
      if (isDisabled || id.replace(QUERY_RE, '') !== options.entry) { return }

      // 如果是入口文件，就使用 magic-string 对源码做字符串操作
      const s = new MagicString(code)

      // 这行代码是为了在不支持 <link rel="modulepreload"> 的浏览器中，模拟其行为（例如旧版 Safari）
      s.prepend('import "vite/modulepreload-polyfill";\n')

      // 返回转换后的代码和 source map
      return {
        code: s.toString(),
        map: options.sourcemap ? s.generateMap({ hires: true }) : undefined,
      }
    },
  }
}
