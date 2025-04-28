import { joinURL } from 'ufo'
import type { Plugin } from 'vite'
import { isCSS } from '../utils'

interface DevStyleSSRPluginOptions {
  srcDir: string
  buildAssetsURL: string
}

// 为什么 Vite 原生没有？
// Vite 的设计里，在开发模式 (dev) 时的 SSR，只保证了模块能返回 export 出来的内容，比如：
// export default { foo: 'bar' }
// export const bar = 'baz'
// 但是 CSS 是通过 <link> 标签在客户端热更新处理的，
// 并不会在服务器返回 HTML 时注入 CSS 内容。
//
// 因为：
//
// Vite 本来就是前端优先（client-side first）的工具。
// Vite 在 Dev 模式下假设你的页面是 "客户端 JS 接管"。
// 正式的 CSS 集成是在 build 阶段，通过 Rollup 插件 vite:css 完成的。
//
// 而 Nuxt 作为 SSR 框架，需要：
// 服务端也要带着样式渲染（不然页面就白屏、闪烁、样式丢失）。
// 所以必须开发自己的一套逻辑来 "Dev SSR 注入 CSS"。
// 于是，Nuxt搞出了 DevStyleSSRPlugin。

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
