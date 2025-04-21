// @ts-check
// 启用 TypeScript 的类型检查，即使文件是 JavaScript，可以在编辑器中获得类型提示和错误检查。
import { Agent as HTTPSAgent } from 'node:https' // 从 Node.js 的 https 模块中导入 Agent 类，并重命名为 HTTPSAgent，用于创建自定义的 HTTPS 请求代理。

import { $fetch } from 'ofetch' // 从 'ofetch' 库中导入 $fetch，这是一个基于 Fetch API 的增强封装，支持更方便的请求和响应处理。


// 指定 `viteNodeOptions` 的类型为 ViteNodeServerOptions，从本地模块 `../vite-node` 中导入类型定义。
/** @type {import('../vite-node').ViteNodeServerOptions} */

// 从环境变量 NUXT_VITE_NODE_OPTIONS 中读取配置（字符串），并用 JSON.parse 解析成对象；
// 如果变量未定义，则默认使用空对象 '{}'，避免解析错误。
export const viteNodeOptions = JSON.parse(process.env.NUXT_VITE_NODE_OPTIONS || '{}')

// 使用 $fetch 的 create 方法创建一个新的 fetch 实例，并赋值给 viteNodeFetch，方便统一配置请求行为。
export const viteNodeFetch = $fetch.create({
  // 设置请求的基础 URL，所有相对路径的请求都会基于这个地址发送。
  baseURL: viteNodeOptions.baseURL,
  // 如果 baseURL 是 https 协议，则使用自定义的 HTTPSAgent 实例；设置 rejectUnauthorized 为 false，表示不验证 SSL 证书（例如用于本地开发环境或自签名证书）。
  // 如果 baseURL 不是 https，则不使用代理（设为 null）。
  agent: viteNodeOptions.baseURL.startsWith('https://')
    ? new HTTPSAgent({ rejectUnauthorized: false })
    : null,
})
