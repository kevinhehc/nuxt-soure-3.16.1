// 引入 Nuxt 提供的工具函数 resolveAlias，用于处理路径别名
import { resolveAlias } from '@nuxt/kit'
import type { Nuxt } from '@nuxt/schema'
import { dirname, isAbsolute, resolve } from 'pathe'
import { createUnplugin } from 'unplugin'

// 虚拟模块的前缀，用于识别虚拟路径
const PREFIX = 'virtual:nuxt:'

// 定义插件接收的参数类型
interface VirtualFSPluginOptions {
  mode: 'client' | 'server' // 指明是客户端模式还是服务端模式
  alias?: Record<string, string>  // 允许传入额外的路径别名
}

// 正则表达式：匹配形如 ./ 或 ../ 的相对路径
const RELATIVE_ID_RE = /^\.{1,2}[\\/]/

// 导出 VirtualFSPlugin 函数，返回一个 Unplugin 插件实例
export const VirtualFSPlugin = (nuxt: Nuxt, options: VirtualFSPluginOptions) => createUnplugin(() => {
  // 获取扩展名数组（包含空字符串代表没有后缀）
  const extensions = ['', ...nuxt.options.extensions]
  // 合并 Nuxt 配置的 alias 与插件额外传入的 alias
  const alias = { ...nuxt.options.alias, ...options.alias }

  // 尝试为某个路径加上扩展名和 mode（client/server）后缀，查找是否在 nuxt.vfs 中存在
  const resolveWithExt = (id: string) => {
    for (const suffix of ['', '.' + options.mode]) {
      for (const ext of extensions) {
        const rId = id + suffix + ext
        if (rId in nuxt.vfs) {
          // 找到匹配项就返回虚拟路径 ID
          return rId
        }
      }
    }
  }

  return {
    name: 'nuxt:virtual',
    resolveId (id, importer) {
      // 使用别名解析路径
      id = resolveAlias(id, alias)

      // 如果是在 Windows 上，且路径是绝对路径，需重新标准化
      if (process.platform === 'win32' && isAbsolute(id)) {
        // Add back C: prefix on Windows
        id = resolve(id)
      }

      // 尝试通过扩展名和 mode 匹配虚拟路径
      const resolvedId = resolveWithExt(id)
      if (resolvedId) {
        return PREFIX + encodeURIComponent(resolvedId) // 返回匹配到的路径
      }

      // 如果是相对路径引用，且有导入者(importer)
      if (importer && RELATIVE_ID_RE.test(id)) {
        // 解析相对于导入者的路径
        const path = resolve(dirname(withoutPrefix(decodeURIComponent(importer))), id)
        const resolved = resolveWithExt(path)
        if (resolved) {
          return PREFIX + encodeURIComponent(resolved) // 返回匹配到的路径
        }
      }
    },

    // 指定哪些模块会被 load 钩子处理
    loadInclude (id) {
      // 模块 ID 是否以 PREFIX 开头且存在于 nuxt.vfs 中
      return id.startsWith(PREFIX) && withoutPrefix(decodeURIComponent(id)) in nuxt.vfs
    },

    // 实际加载模块的内容
    load (id) {
      return {
        // 返回对应虚拟文件的代码内容
        code: nuxt.vfs[withoutPrefix(decodeURIComponent(id))] || '',
        // 没有提供 source map
        map: null,
      }
    },
  }
})

// 辅助函数：去掉虚拟路径前缀
function withoutPrefix (id: string) {
  return id.startsWith(PREFIX) ? id.slice(PREFIX.length) : id
}
