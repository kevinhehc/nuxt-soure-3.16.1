// @ts-check
// 启用 TypeScript 检查，即使这是一个 .js 文件，也让编辑器执行类型检查，有助于代码提示和错误检测。
import { viteNodeFetch } from './vite-node-shared.mjs'
// 从同一目录下引入名为 vite-node-shared.mjs 的模块，解构出其中的 viteNodeFetch 函数，用于执行类 fetch 请求。

// 在 SSR 渲染过程中，Nuxt 需要知道：
// 某个页面（比如 /about）用了哪些 JS chunk、CSS chunk。
// 这些资源（scripts, styles）需要插到 <head> 或 <body> 里，确保客户端能正确 hydrate。
// client.manifest.mjs 就是记录这些信息的地方！
// 它包含了：
// 每个模块的依赖关系（比如 /src/pages/about.vue 需要哪些 chunk）
// 哪些 CSS 文件需要 link
// 哪些动态 import 的 chunk
// 资源文件的实际 URL（比如加了 hash 的 /assets/about.123abc.js）

// 帮助 Nuxt 的 renderToString 在 SSR时插入正确的 <script> 和 <link>。
// 开发模式和生产模式都需要用，只是生成方式不一样。

export default () => viteNodeFetch('/manifest')
// 默认导出一个函数，该函数调用 viteNodeFetch，向路径 /manifest 发送请求，返回其内容。
// 这个函数通常用于在 Vite SSR 模式下获取构建产物的 manifest（资源映射文件），用于服务端渲染时加载正确的静态资源。



// demo
// {
//   "modules": {
//     "/src/pages/about.vue": {
//       "file": "assets/about.123abc.js",
//       "css": ["assets/about.123abc.css"],
//       "imports": ["assets/vendor.456def.js"]
//     }
//   }
// }
