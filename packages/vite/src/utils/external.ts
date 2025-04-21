import type { ExternalsOptions } from 'externality' // 从 externality 包中导入类型定义 ExternalsOptions，用于指定外部模块的匹配规则
import { ExternalsDefaults, isExternal } from 'externality' // 从 externality 包中导入默认选项 ExternalsDefaults 和判断是否为外部模块的函数 isExternal
import type { ViteDevServer } from 'vite'  // 从 Vite 中导入开发服务器类型 ViteDevServer，用于类型标注
import escapeStringRegexp from 'escape-string-regexp' // 引入 escape-string-regexp，用于将字符串转义为正则表达式安全格式
import { withTrailingSlash } from 'ufo' // 从 ufo 工具库中导入 withTrailingSlash，用于为路径添加结尾的斜杠（/）
import type { Nuxt } from 'nuxt/schema' // 引入 Nuxt 类型定义，用于访问 Nuxt 配置和上下文
import { resolve } from 'pathe' // 引入 resolve 方法，用于将路径解析为绝对路径
import { toArray } from '.' // 从当前模块导入 toArray 工具函数，将单项或数组统一转为数组

// 定义一个 createIsExternal 工厂函数，接收 Vite 开发服务器实例和 Nuxt 实例
export function createIsExternal (viteServer: ViteDevServer, nuxt: Nuxt) {
  // 定义外部模块配置 externalOpts，符合 ExternalsOptions 接口
  const externalOpts: ExternalsOptions = {
    // inline 配置：指定应该被内联打包的模块（即不是外部依赖）
    inline: [
      /virtual:/, // 内联所有虚拟模块（Vite 虚拟模块）
      /\.ts$/, // 内联所有 .ts 文件
      ...ExternalsDefaults.inline || [], // 合并 externality 包中的默认 inline 配置（如存在）
      ...(
        // 如果 Vite 的 ssr.noExternal 被设置（不是 true，而是数组或字符串），也内联这些模块
        viteServer.config.ssr.noExternal && viteServer.config.ssr.noExternal !== true
          ? toArray(viteServer.config.ssr.noExternal)
          : [] // 否则为空数组
      ),
    ],
    // external 配置：指定哪些模块应该被视为外部模块，不被打包进 SSR bundle
    external: [
      // 明确标记 '#shared' 模块为外部模块
      '#shared',
      // 将 shared 目录的路径转义为正则表达式，匹配以该路径开头的模块
      new RegExp('^' + escapeStringRegexp(withTrailingSlash(resolve(nuxt.options.rootDir, nuxt.options.dir.shared)))),
      // 合并用户在 vite.config 中设置的 ssr.external 配置
      ...(viteServer.config.ssr.external as string[]) || [],
      // 默认将 node_modules 中的模块视为外部模块
      /node_modules/,
    ],
    // resolve 配置：用于解析模块路径的辅助设置
    resolve: {
      // 指定模块目录为 Nuxt 配置中的 modulesDir
      modules: nuxt.options.modulesDir,
      // 指定模块类型为 ECMAScript 模块
      type: 'module',
      // 支持的模块扩展名
      extensions: ['.ts', '.js', '.json', '.vue', '.mjs', '.jsx', '.tsx', '.wasm'],
    },
  }

  return (id: string) => isExternal(id, nuxt.options.rootDir, externalOpts)
}
