// @ts-check
// 启用 TypeScript 检查，即使这是一个 .js 文件，也让编辑器执行类型检查，有助于代码提示和错误检测。
import { viteNodeFetch } from './vite-node-shared.mjs'
// 从同一目录下引入名为 vite-node-shared.mjs 的模块，解构出其中的 viteNodeFetch 函数，用于执行类 fetch 请求。


export default () => viteNodeFetch('/manifest')
// 默认导出一个函数，该函数调用 viteNodeFetch，向路径 /manifest 发送请求，返回其内容。
// 这个函数通常用于在 Vite SSR 模式下获取构建产物的 manifest（资源映射文件），用于服务端渲染时加载正确的静态资源。

