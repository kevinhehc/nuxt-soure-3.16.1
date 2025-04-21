import { joinURL } from 'ufo'
import type { Plugin } from 'vite'
import { isCSS } from '../utils'

interface DevStyleSSRPluginOptions {
  srcDir: string
  buildAssetsURL: string
}

// 开发模式下用于处理 CSS 热更新的 Vite 插件
// 为了在开发阶段进行 SSR（服务端渲染）时，避免重复的 CSS 样式注入，提升热重载体验。
export function DevStyleSSRPlugin (options: DevStyleSSRPluginOptions): Plugin {
  return {
    name: 'nuxt:dev-style-ssr',
    apply: 'serve', // 仅在开发模式生效。
    enforce: 'post', // 插件在 transform 阶段的后期执行。
    transform (code, id) {
      // isCSS：一个工具函数，用来判断文件是否为 CSS 文件。
      // 检查带有 import.meta.hot 的 CSS 模块（即支持 HMR 的 CSS 文件）
      if (!isCSS(id) || !code.includes('import.meta.hot')) {
        return
      }

      // 去除 CSS 模块的源目录前缀，获取相对路径。
      let moduleId = id
      if (moduleId.startsWith(options.srcDir)) {
        moduleId = moduleId.slice(options.srcDir.length)
      }

      // 构建 selectors，移除 <link> 样式
      // When dev `<style>` is injected, remove the `<link>` styles from manifest
      const selectors = [joinURL(options.buildAssetsURL, moduleId), joinURL(options.buildAssetsURL, '@fs', moduleId)]
      return code + selectors.map(selector => `\ndocument.querySelectorAll(\`link[href="${selector}"]\`).forEach(i=>i.remove())`).join('')
    },
  }
}
