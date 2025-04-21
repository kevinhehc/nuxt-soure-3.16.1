import { builtinModules } from 'node:module'
import { logger } from '@nuxt/kit'
import { join, normalize, relative } from 'pathe'
import { withoutBase } from 'ufo'
import { isCSSRequest } from 'vite'
import type { ViteDevServer } from 'vite'

// https://github.com/vitejs/vite/tree/main/packages/vite/src/node/server/warmup.ts#L62-L70
/**
 * 将文件路径转换为 URL 路径
 * 来自 Vite 的 warmup 逻辑（https://github.com/vitejs/vite/...）
 * @param file - 文件的绝对路径
 * @param root - Vite 的项目根目录
 */
function fileToUrl (file: string, root: string) {
  const url = relative(root, file)
  // out of root, use /@fs/ prefix
  // 如果文件不在根目录内，添加 /@fs/ 前缀（代表本地文件系统访问）
  if (url[0] === '.') {
    return join('/@fs/', normalize(file))
  }
  // file within root, create root-relative url
  // 否则返回以 / 开头的相对路径 URL
  return '/' + normalize(url)
}


/**
 * 标准化模块 URL，移除 base 路径、Vite 特殊前缀和 query 参数
 * @param url - 原始 URL
 * @param base - Vite 配置中的 base 路径
 */
function normaliseURL (url: string, base: string) {
  // remove any base url
  // 去掉 base 路径
  url = withoutBase(url, base)
  // unwrap record
  // 如果 URL 以 /@id/ 开头，说明是 Vite 的虚拟模块 ID，去掉前缀
  if (url.startsWith('/@id/')) {
    url = url.slice('/@id/'.length).replace('__x00__', '\0')
  }
  // strip query
  // 移除 URL 中的 import query 参数
  url = url.replace(/(\?|&)import=?(?:&|$)/, '').replace(/[?&]$/, '')
  return url
}

// TODO: remove when we drop support for node 18
const builtins = new Set(builtinModules)
// 创建一个 Set，包含所有内置模块名称
/**
 * 判断一个模块是否是 Node.js 内置模块
 * @param id - 模块 ID
 */
function isBuiltin (id: string) {
  return id.startsWith('node:') || builtins.has(id)
}

// TODO: use built-in warmup logic when we update to vite 5
/**
 * 预热 Vite 服务，确保某些模块被提前加载和编译，加快开发体验
 * @param server - Vite 开发服务器实例
 * @param entries - 需要预热的入口模块路径数组
 * @param isServer - 是否为 SSR（服务器渲染）模式
 */
export async function warmupViteServer (
  server: ViteDevServer,
  entries: string[],
  isServer: boolean,
) {
  // 存储已经被预热过的 URL，防止重复处理
  const warmedUrls = new Set<string>()

  /**
   * 递归预热一个模块及其依赖
   * @param url - 模块 URL
   */
  const warmup = async (url: string) => {
    try {
      // 标准化 URL（去掉 base、@id、query 参数等）
      url = normaliseURL(url, server.config.base)

      // 如果已经预热过或者是内置模块，直接跳过
      if (warmedUrls.has(url) || isBuiltin(url)) { return }
      // 尝试从 Vite 模块图中获取模块
      const m = await server.moduleGraph.getModuleByUrl(url, isServer)
      // a module that is already compiled (and can't be warmed up anyway)
      // 如果模块已经有 transform 结果，说明已编译，无需再次处理
      if (m?.transformResult?.code || m?.ssrTransformResult?.code) {
        return
      }
      // 记录已预热
      warmedUrls.add(url)
      // 对模块进行 transform（编译）
      await server.transformRequest(url, { ssr: isServer })
    } catch (e) {
      // 日志记录预热失败的模块
      logger.debug('[nuxt] warmup for %s failed with: %s', url, e)
    }

    // Don't warmup CSS file dependencies as they have already all been loaded to produce result
    // 如果是 CSS 文件，不需要继续递归依赖
    if (isCSSRequest(url)) { return }

    try {
      // 再次获取模块，获取其依赖列表
      const mod = await server.moduleGraph.getModuleByUrl(url, isServer)
      // 获取模块的依赖（根据 SSR 或客户端逻辑分别处理）
      const deps = mod?.ssrTransformResult?.deps /* server */ || (mod?.importedModules.size ? Array.from(mod?.importedModules /* client */).map(m => m.url) : [])
      // 并行递归处理依赖模块
      await Promise.all(deps.map(m => warmup(m)))
    } catch (e) {
      // 日志记录依赖追踪失败的模块
      logger.debug('[warmup] tracking dependencies for %s failed with: %s', url, e)
    }
  }

  // 并行预热所有入口模块
  await Promise.all(entries.map(entry => warmup(fileToUrl(entry, server.config.root))))
}
