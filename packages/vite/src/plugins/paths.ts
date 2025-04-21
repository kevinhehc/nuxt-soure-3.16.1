// 引入用于将路径转换为文件 URL 的 Node 工具
import { pathToFileURL } from 'node:url'
// 引入 magic-string，用于修改源码字符串
import MagicString from 'magic-string'
// 从 ufo 包中引入 URL 和查询参数解析工具
import { parseQuery, parseURL } from 'ufo'
// 引入 Vite 的插件类型
import type { Plugin } from 'vite'
// 自定义工具，用于判断是否是 CSS 文件
import { isCSS } from '../utils'

interface RuntimePathsOptions {
  sourcemap?: boolean
}

// 静态资源替换标记的正则表达式，Vite 在资源替换时会插入这些标记
const VITE_ASSET_RE = /__VITE_ASSET__|__VITE_PUBLIC_ASSET__/


export function RuntimePathsPlugin (options: RuntimePathsOptions): Plugin {
  return {
    name: 'nuxt:runtime-paths-dep', // 插件名
    enforce: 'post',  // 在其他插件之后执行

    // 针对每个模块进行代码转换
    transform (code, id) {
      // 解析模块路径和查询参数
      const { pathname, search } = parseURL(decodeURIComponent(pathToFileURL(id).href))

      // skip import into css files
      // 跳过处理 CSS 文件
      if (isCSS(pathname)) { return }

      // skip import into <style> vue files
      // 跳过 .vue 文件中的 <style> 块
      if (pathname.endsWith('.vue')) {
        if (search && parseQuery(search).type === 'style') { return }
      }

      // 检查代码中是否包含 Vite 的资源替换标记
      if (VITE_ASSET_RE.test(code)) {
        const s = new MagicString(code)
        // Register dependency on #build/paths.mjs or #internal/nuxt/paths.mjs, which sets globalThis.__publicAssetsURL
        // 插入对 "#internal/nuxt/paths" 的导入，注册依赖，确保运行时有路径替换逻辑
        s.prepend('import "#internal/nuxt/paths";')

        return {
          code: s.toString(), // 返回修改后的代码
          map: options.sourcemap // 如果启用了 sourcemap，就生成 source map
            ? s.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
}
