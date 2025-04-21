// 类型导入，用于处理 AST 节点
import type { Literal, Property, SpreadElement } from 'estree'
// 合并对象的工具，优先保留已有属性
import { defu } from 'defu'
// 找出代码中的 export 声明
import { findExports } from 'mlly'
// Nuxt 类型定义
import type { Nuxt } from '@nuxt/schema'
// 创建 Vite/Rollup/Webpack 通用插件的工具
import { createUnplugin } from 'unplugin'
// 用于字符串源码编辑，支持生成 sourcemap
import MagicString from 'magic-string'
// 处理文件路径的 cross-platform 工具
import { normalize } from 'pathe'
// 插件元信息类型
import type { ObjectPlugin, PluginMeta } from 'nuxt/app'

// 自定义 AST 解析与遍历工具函数
import { parseAndWalk, withLocations } from '../../core/utils/parse'
// Nuxt 自带的日志工具
import { logger } from '../../utils'

// 插件执行顺序映射（internalOrderMap）
// 插件执行顺序的权重映射表，负数表示越早执行。
const internalOrderMap = {
  // -50: pre-all (nuxt)
  'nuxt-pre-all': -50,
  // -40: custom payload revivers (user)
  'user-revivers': -40,
  // -30: payload reviving (nuxt)
  'nuxt-revivers': -30,
  // -20: pre (user) <-- pre mapped to this
  'user-pre': -20,
  // -10: default (nuxt)
  'nuxt-default': -10,
  // 0: default (user) <-- default behavior
  'user-default': 0,
  // +10: post (nuxt)
  'nuxt-post': 10,
  // +20: post (user) <-- post mapped to this
  'user-post': 20,
  // +30: post-all (nuxt)
  'nuxt-post-all': 30,
}

// orderMap：公开的 enforce->order 映射
// 暴露给外部使用的简化映射，基于插件的 enforce 值（pre | default | post）换算为执行顺序。
export const orderMap: Record<NonNullable<ObjectPlugin['enforce']>, number> = {
  pre: internalOrderMap['user-pre'],
  default: internalOrderMap['user-default'],
  post: internalOrderMap['user-post'],
}

// 用于缓存处理结果，避免重复计算。
const metaCache: Record<string, Omit<PluginMeta, 'enforce'>> = {}

// 传入源码字符串和语言类型 (ts or tsx)。
export function extractMetadata (code: string, loader = 'ts' as 'ts' | 'tsx') {
  let meta: PluginMeta = {}
  if (metaCache[code]) {
    return metaCache[code]
  }
  if (code.match(/defineNuxtPlugin\s*\([\w(]/)) {
    return {}
  }
  // 遍历 AST，找到：
  parseAndWalk(code, `file.${loader}`, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }

    const name = 'name' in node.callee && node.callee.name
    // 首先跳过 defineNuxtPlugin(xxx) 情况（无 metadata 参数）。
    if (name !== 'defineNuxtPlugin' && name !== 'definePayloadPlugin') { return }

    // definePayloadPlugin ➜ 自动设置 order
    if (name === 'definePayloadPlugin') {
      meta.order = internalOrderMap['user-revivers']
    }

    // 提取第二个参数（metadata 对象）
    const metaArg = node.arguments[1]
    if (metaArg) {
      if (metaArg.type !== 'ObjectExpression') {
        throw new Error('Invalid plugin metadata')
      }
      meta = extractMetaFromObject(metaArg.properties)
    }

    // 如果第一个参数是对象，也尝试提取并合并（defu）
    const plugin = node.arguments[0]
    if (plugin?.type === 'ObjectExpression') {
      meta = defu(extractMetaFromObject(plugin.properties), meta)
    }

    // 如果未设置 order，则基于 enforce 推导出默认值。
    meta.order ||= orderMap[meta.enforce || 'default'] || orderMap.default
    delete meta.enforce
  })
  metaCache[code] = meta
  return meta as Omit<PluginMeta, 'enforce'>
}

type PluginMetaKey = keyof PluginMeta
const keys: Record<PluginMetaKey, string> = {
  name: 'name',
  order: 'order',
  enforce: 'enforce',
  dependsOn: 'dependsOn',
}
// 判断一个属性名是否是插件元数据的合法字段（类型保护）。
function isMetadataKey (key: string): key is PluginMetaKey {
  return key in keys
}

// 元数据提取辅助函数
// 遍历对象中的属性键值，提取并验证支持的字段，包括：
// name / order / enforce: 字面量或一元表达式
// dependsOn: 必须是字符串数组
// 非法字段将被忽略或抛出错误
function extractMetaFromObject (properties: Array<Property | SpreadElement>) {
  const meta: PluginMeta = {}
  for (const property of properties) {
    if (property.type === 'SpreadElement' || !('name' in property.key)) {
      throw new Error('Invalid plugin metadata')
    }
    const propertyKey = property.key.name

    if (!isMetadataKey(propertyKey)) { continue }
    if (property.value.type === 'Literal') {
      meta[propertyKey] = property.value.value as any
    }
    if (property.value.type === 'UnaryExpression' && property.value.argument.type === 'Literal') {
      meta[propertyKey] = JSON.parse(property.value.operator + property.value.argument.raw!)
    }

    // 非法字段将被忽略或抛出错误
    if (propertyKey === 'dependsOn' && property.value.type === 'ArrayExpression') {
      if (property.value.elements.some(e => !e || e.type !== 'Literal' || typeof e.value !== 'string')) {
        throw new Error('dependsOn must take an array of string literals')
      }
      meta[propertyKey] = property.value.elements.map(e => (e as Literal)!.value as string)
    }
  }
  return meta
}

// 移除插件元数据的构建插件
// 返回一个 unplugin 插件实例，处理 .ts/.js 插件文件中的默认导出。
export const RemovePluginMetadataPlugin = (nuxt: Nuxt) => createUnplugin(() => {
  return {
    name: 'nuxt:remove-plugin-metadata',
    transform (code, id) {
      id = normalize(id)
      // 匹配当前文件是否为已注册的插件
      const plugin = nuxt.apps.default?.plugins.find(p => p.src === id)
      if (!plugin) { return }

      if (!code.trim()) {
        logger.warn(`Plugin \`${plugin.src}\` has no content.`)

        return {
          code: 'export default () => {}',
          map: null,
        }
      }

      // 检查是否导出 default，否则警告并添加空函数导出
      const exports = findExports(code)
      const defaultExport = exports.find(e => e.type === 'default' || e.name === 'default')
      if (!defaultExport) {
        logger.warn(`Plugin \`${plugin.src}\` has no default export and will be ignored at build time. Add \`export default defineNuxtPlugin(() => {})\` to your plugin.`)
        return {
          code: 'export default () => {}',
          map: null,
        }
      }

      const s = new MagicString(code)
      let wrapped = false
      const wrapperNames = new Set(['defineNuxtPlugin', 'definePayloadPlugin'])

      try {
        // 使用 AST 查找：
        parseAndWalk(code, id, (node) => {
          if (node.type === 'ImportSpecifier' && node.imported.type === 'Identifier' && (node.imported.name === 'defineNuxtPlugin' || node.imported.name === 'definePayloadPlugin')) {
            wrapperNames.add(node.local.name)
          }

          if (node.type === 'ExportDefaultDeclaration' && (node.declaration.type === 'FunctionDeclaration' || node.declaration.type === 'ArrowFunctionExpression')) {
            if ('params' in node.declaration && node.declaration.params.length > 1) {
              logger.warn(`Plugin \`${plugin.src}\` is in legacy Nuxt 2 format (context, inject) which is likely to be broken and will be ignored.`)
              s.overwrite(0, code.length, 'export default () => {}')
              wrapped = true // silence a duplicate error
              return
            }
          }

          if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier') { return }

          const name = 'name' in node.callee && node.callee.name
          if (!name || !wrapperNames.has(name)) { return }
          wrapped = true

          if (node.arguments[0] && node.arguments[0].type !== 'ObjectExpression') {
            // TODO: Warn if legacy plugin format is detected
            if ('params' in node.arguments[0] && node.arguments[0].params.length > 1) {
              logger.warn(`Plugin \`${plugin.src}\` is in legacy Nuxt 2 format (context, inject) which is likely to be broken and will be ignored.`)
              s.overwrite(0, code.length, 'export default () => {}')
              return
            }
          }

          // Remove metadata that already has been extracted
          if (!('order' in plugin) && !('name' in plugin)) { return }
          for (const [argIndex, arg] of node.arguments.entries()) {
            if (arg.type !== 'ObjectExpression') { continue }

            for (const [propertyIndex, property] of arg.properties.entries()) {
              if (property.type === 'SpreadElement' || !('name' in property.key)) { continue }

              const propertyKey = property.key.name
              // 如果 wrapper 参数中包含 name/order/enforce，就用 MagicString 移除这些属性（这些已经被提取并缓存）
              if (propertyKey === 'order' || propertyKey === 'enforce' || propertyKey === 'name') {
                const nextNode = arg.properties[propertyIndex + 1] || node.arguments[argIndex + 1]
                const nextIndex = withLocations(nextNode)?.start || (withLocations(arg).end - 1)

                s.remove(withLocations(property).start, nextIndex)
              }
            }
          }
        })
      } catch (e) {
        logger.error(e)
        return
      }

      // 如果没有包裹在 defineNuxtPlugin() 中，也会警告（将来可能导致不可用）。
      if (!wrapped) {
        logger.warn(`Plugin \`${plugin.src}\` is not wrapped in \`defineNuxtPlugin\`. It is advised to wrap your plugins as in the future this may enable enhancements.`)
      }

      // 如果代码被修改，则返回修改后的代码和 sourcemap。
      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: nuxt.options.sourcemap.client || nuxt.options.sourcemap.server ? s.generateMap({ hires: true }) : null,
        }
      }
    },
  }
})
