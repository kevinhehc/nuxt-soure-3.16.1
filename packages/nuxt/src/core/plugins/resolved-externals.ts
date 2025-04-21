// 引入 Vite 插件类型定义
import type { Plugin } from 'vite'
// Nuxt 工具函数，用于动态导入模块
import { tryImportModule } from '@nuxt/kit'
// 引入 Nuxt 和 Nitro 的类型定义
import type { Nuxt } from '@nuxt/schema'
import type { Nitro } from 'nitropack'
// 引入 package.json 的类型定义
import type { PackageJson } from 'pkg-types'
// 引入一个模块路径解析工具
import { resolveModulePath } from 'exsolve'

// 从 meta.mjs 文件中导入 Nuxt 运行时依赖列表
import { runtimeDependencies as runtimeNuxtDependencies } from '../../meta.mjs'

export function ResolveExternalsPlugin (nuxt: Nuxt): Plugin {
  // 定义一个存储需要 external 化的模块名集合
  let external: Set<string> = new Set()

  return {
    name: 'nuxt:resolve-externals',
    enforce: 'pre',
    async configResolved () {
      // 如果不是开发模式
      if (!nuxt.options.dev) {
        // 读取 nitropack 的依赖包名列表
        const runtimeNitroDependencies = await tryImportModule<PackageJson>('nitropack/package.json', {
          url: new URL(import.meta.url), // 设置导入路径的 URL 来源
        })?.then(r => r?.dependencies ? Object.keys(r.dependencies) : []).catch(() => []) || [] // 如果存在 dependencies 字段则取其 key // 出现错误时返回空数组

        // 初始化需要 external 化的模块集合
        external = new Set([
          // explicit dependencies we use in our ssr renderer - these can be inlined (if necessary) in the nitro build
          // SSR 渲染器中显式使用的依赖（可由 nitro 构建时 inline）
          'unhead', '@unhead/vue', '@nuxt/devalue', 'rou3', 'unstorage',
          // ensure we only have one version of vue if nitro is going to inline anyway
          // 如果 nitro 会 inline 动态导入，则避免多版本的 Vue
          ...((nuxt as any)._nitro as Nitro).options.inlineDynamicImports ? ['vue', '@vue/server-renderer'] : [],
          // Nuxt 运行时依赖
          ...runtimeNuxtDependencies,
          // dependencies we might share with nitro - these can be inlined (if necessary) in the nitro build
          // nitro 的依赖（也是构建时可能共享的）
          ...runtimeNitroDependencies,
        ])
      }
    },
    async resolveId (id, importer) {
      // 如果当前模块 ID 不在 external 列表中，则跳过
      if (!external.has(id)) {
        return
      }

      // 尝试使用 Vite 默认的模块解析逻辑（跳过自己，避免无限递归）
      const res = await this.resolve?.(id, importer, { skipSelf: true })
      // 如果找到了模块路径
      if (res !== undefined && res !== null) {
        // 若解析出的路径与 ID 相同，说明路径未变
        if (res.id === id) {
          // 使用 exsolve 工具尝试更精确地解析模块路径
          res.id = resolveModulePath(res.id, {
            try: true,
            from: importer, // 指定起始导入路径
            extensions: nuxt.options.extensions,  // 支持的扩展名（如 .ts, .js, .vue）
          }) || res.id
        }
        // 返回解析结果并标记为 external，表示构建时不要打包它
        return {
          ...res,
          external: 'absolute',  // 表示这是一个绝对 external 模块
        }
      }
    },
  }
}
