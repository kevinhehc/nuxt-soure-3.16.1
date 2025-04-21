// 引入 createUnplugin 用于创建一个兼容 Vite 和 Webpack 的插件
import { createUnplugin } from 'unplugin'
// 导入 Nuxt 配置层类型
import type { NuxtConfigLayer } from 'nuxt/schema'
// 导入用于解析路径别名的工具函数
import { resolveAlias } from '@nuxt/kit'
// 统一路径格式（支持跨平台）
import { normalize } from 'pathe'
// 引入 MagicString 用于代码字符串的修改（支持生成 sourcemap）
import MagicString from 'magic-string'

// 定义插件的参数类型接口
interface LayerAliasingOptions {
  // 是否生成源码映射
  sourcemap?: boolean
  // 项目根目录
  root: string
  // 是否开发模式
  dev: boolean
  // 配置层数组（每一层可能有自己的 srcDir 和 alias）
  layers: NuxtConfigLayer[]
}

// 正则表达式：匹配路径中以 ~ 或 @ 开头的别名（例如 ~/, @/）
const ALIAS_RE = /(?<=['"])[~@]{1,2}(?=\/)/g
const ALIAS_RE_SINGLE = /(?<=['"])[~@]{1,2}(?=\/)/

// 定义 Nuxt Layer 别名处理插件
export const LayerAliasingPlugin = (options: LayerAliasingOptions) => createUnplugin((_options, meta) => {
  // 构建每个 layer 的 alias 映射（每个 srcDir 关联一套 alias 配置）
  const aliases: Record<string, Record<string, string>> = {}
  for (const layer of options.layers) {
    const srcDir = layer.config.srcDir || layer.cwd // 当前层的源码目录
    const rootDir = layer.config.rootDir || layer.cwd // 当前层的根目录

    // 给每个 srcDir 设置其路径别名对应的实际路径（如 ~ -> srcDir, ~~ -> rootDir）
    aliases[srcDir] = {
      '~': layer.config?.alias?.['~'] || srcDir,
      '@': layer.config?.alias?.['@'] || srcDir,
      '~~': layer.config?.alias?.['~~'] || rootDir,
      '@@': layer.config?.alias?.['@@'] || rootDir,
    }
  }
  // 获取按路径长度排序的 srcDir 列表，长路径优先匹配（避免冲突）
  const layers = Object.keys(aliases).sort((a, b) => b.length - a.length)

  return {
    // 插件名
    name: 'nuxt:layer-aliasing',
    // 插件运行优先级，优先处理路径
    enforce: 'pre',
    // Vite 中的解析逻辑（主要作用于开发环境）
    vite: {
      resolveId: {
        // 在默认解析之前运行
        order: 'pre',
        async handler (id, importer) {
          // 没有导入者则跳过
          if (!importer) { return }

          // 找到对应的 layer（按路径前缀匹配）
          const layer = layers.find(l => importer.startsWith(l))
          if (!layer) { return }

          // 使用该层的 alias 尝试解析 import 路径
          const resolvedId = resolveAlias(id, aliases[layer])
          if (resolvedId !== id) {
            // 返回解析后的路径，跳过当前插件（避免递归）
            return await this.resolve(resolvedId, importer, { skipSelf: true })
          }
        },
      },
    },

    // webpack-only transform
    // Webpack 模式下才启用 transform
    transformInclude: (id) => {
      // 如果当前是 Vite 环境，跳过 transform 逻辑
      if (meta.framework === 'vite') { return false }

      // 标准化路径（跨平台兼容）
      const _id = normalize(id)
      // 判断是否属于任意一个 layer
      return layers.some(dir => _id.startsWith(dir))
    },

    // Webpack 模式下的代码转换逻辑
    transform (code, id) {
      if (meta.framework === 'vite') { return }

      const _id = normalize(id)
      const layer = layers.find(l => _id.startsWith(l))
      // 若找不到匹配层或代码中没有匹配的别名，跳过转换
      if (!layer || !ALIAS_RE_SINGLE.test(code)) { return }

      // 使用 MagicString 对源代码进行替换
      const s = new MagicString(code)
      // 替换别名（如 ~ -> 实际路径）
      s.replace(ALIAS_RE, r => aliases[layer]?.[r as '~'] || r)

      // 若代码发生变化，返回修改后的代码及 sourcemap（可选）
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap ? s.generateMap({ hires: true }) : undefined,
        }
      }
    },
  }
})
