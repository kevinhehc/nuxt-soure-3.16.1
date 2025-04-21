// @ts-check
// 启用 TypeScript 的类型检查，即使这是一个 .js 文件

import { performance } from 'node:perf_hooks' // 引入 Node.js 的性能计时工具，用于测量渲染时间
import { createError } from 'h3' // 引入 h3 框架的 createError 函数，用于构造标准错误对象
import { ViteNodeRunner } from 'vite-node/client' // 从 vite-node 引入 ViteNodeRunner，用于运行 Vite 模块
import { consola } from 'consola' // 引入 consola，用于在控制台输出美化的日志
import { viteNodeFetch, viteNodeOptions } from './vite-node-shared.mjs' // 引入自定义的 fetch 函数和 vite-node 配置选项（如 root、entryPath 等）

// 创建并初始化 vite-node 运行器实例
const runner = createRunner()

/** @type {(ssrContext: import('#app').NuxtSSRContext) => Promise<any>} */
// 声明一个变量 render，用于保存 SSR 渲染函数
let render

/** @param ssrContext {import('#app').NuxtSSRContext} */
export default async (ssrContext) => {
  // Workaround for stub mode
  // https://github.com/nuxt/framework/pull/3983
  // eslint-disable-next-line nuxt/prefer-import-meta
  process.server = true
  import.meta.server = true
  // 兼容处理：显式声明当前运行环境为服务端，解决 stub 模式下识别问题

  // Invalidate cache for files changed since last rendering
  // 调用自定义接口获取自上次渲染以来被修改的模块列表
  const invalidates = await viteNodeFetch('/invalidates')

  // 使这些模块和它们的依赖在缓存中失效，实现热模块替换（HMR）
  const updates = runner.moduleCache.invalidateDepTree(invalidates)

  // Execute SSR bundle on demand
  // 记录当前时间，用于计算执行时间
  const start = performance.now()

  // 如果入口文件被更新，或者 render 还未初始化，就重新执行入口文件并获取默认导出（SSR 渲染函数）
  render = (updates.has(viteNodeOptions.entryPath) || !render) ? (await runner.executeFile(viteNodeOptions.entryPath)).default : render
  if (updates.size) {
    // 计算从开始到现在的耗时（以毫秒为单位）
    const time = Math.round((performance.now() - start) * 1000) / 1000
    // 打印 HMR 成功日志，包含变动文件数量和耗时
    consola.success(`Vite server hmr ${updates.size} files`, time ? `in ${time}ms` : '')
  }

  // 调用渲染函数，执行服务端渲染
  const result = await render(ssrContext)
  return result
}

function createRunner () {
  return new ViteNodeRunner({
    // 指定项目根目录，一般是 Nuxt 的 srcDir
    root: viteNodeOptions.root, // Equals to Nuxt `srcDir`
    // 基础路径（通常是 Vite 构建时的 base 配置）
    base: viteNodeOptions.base,
    async resolveId (id, importer) {
      // 自定义模块 ID 解析逻辑，向服务端发送请求解析模块路径
      return await viteNodeFetch('/resolve/' + encodeURIComponent(id) + (importer ? '?importer=' + encodeURIComponent(importer) : '')) ?? undefined
    },
    async fetchModule (id) {
      // 处理双斜杠的问题（兼容路径）
      id = id.replace(/\/\//g, '/') // TODO: fix in vite-node
      // 从服务端拉取模块内容，如果失败则处理错误
      return await viteNodeFetch('/module/' + encodeURI(id)).catch((err) => {
        const errorData = err?.data?.data
        // 如果没有返回错误详情，就直接抛出原始错误
        if (!errorData) {
          throw err
        }
        let _err
        try {
          // 格式化 vite-node 错误信息，并抛出一个符合 H3 规范的错误对象
          const { message, stack } = formatViteError(errorData, id)
          _err = createError({
            statusMessage: 'Vite Error',
            message,
            stack,
          })
        } catch (formatError) {
          consola.warn('Internal nuxt error while formatting vite-node error. Please report this!', formatError)
          const message = `[vite-node] [TransformError] ${errorData?.message || '-'}`
          consola.error(message, errorData)
          throw createError({
            statusMessage: 'Vite Error',
            message,
            stack: `${message}\nat ${id}\n` + (errorData?.stack || ''),
          })
        }
        throw _err
      })
    },
  })
}

/**
 * @param errorData {any}
 * @param id {string}
 */
function formatViteError (errorData, id) {
  // 获取错误代码（可能来源于插件名、错误码等）
  const errorCode = errorData.name || errorData.reasonCode || errorData.code
  // 获取源码片段，用于在控制台展示
  const frame = errorData.frame || errorData.source || errorData.pluginCode

  /** @param locObj {{ file?: string, id?: string, url?: string }} */
    // 从错误对象中提取文件路径（优先 file > id > url）
  const getLocId = (locObj = {}) => locObj.file || locObj.id || locObj.url || id || ''
  // 提取行号和列号信息，如果没有就返回空字符串
  /** @param locObj {{ line?: string, column?: string }} */
  const getLocPos = (locObj = {}) => locObj.line ? `${locObj.line}:${locObj.column || 0}` : ''

  // 构造完整的错误位置描述，去除项目根目录路径
  const locId = getLocId(errorData.loc) || getLocId(errorData.location) || getLocId(errorData.input) || getLocId(errorData)
  const locPos = getLocPos(errorData.loc) || getLocPos(errorData.location) || getLocPos(errorData.input) || getLocPos(errorData)
  const loc = locId.replace(process.cwd(), '.') + (locPos ? `:${locPos}` : '')

  // 构造用户可读的错误消息，包含插件名、错误码、位置、原因和源码片段
  const message = [
    '[vite-node]',
    errorData.plugin && `[plugin:${errorData.plugin}]`,
    errorCode && `[${errorCode}]`,
    loc,
    errorData.reason && `: ${errorData.reason}`,
    frame && `<br><pre>${frame.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre><br>`,
  ].filter(Boolean).join(' ')

  // 构造完整的堆栈信息（包括上面 message）
  const stack = [
    message,
    `at ${loc}`,
    errorData.stack,
  ].filter(Boolean).join('\n')

  // 返回标准化的错误信息对象
  return {
    message,
    stack,
  }
}
