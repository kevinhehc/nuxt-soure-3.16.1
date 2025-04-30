import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import type { Identifier, ImportSpecifier } from 'estree'
import { normalize, relative } from 'pathe'
import { unheadVueComposablesImports } from '@unhead/vue'
import { genImport } from 'knitwork'
import { parseAndWalk, withLocations } from '../../core/utils/parse'
import { isJS, isVue } from '../../core/utils'
import { distDir } from '../../dirs'
import { logger } from '../../utils'

interface UnheadImportsPluginOptions {
  sourcemap: boolean
  rootDir: string
}

const UNHEAD_LIB_RE = /node_modules[/\\](?:@unhead[/\\][^/\\]+|unhead)[/\\]/

function toImports (specifiers: ImportSpecifier[]) {
  return specifiers.map((specifier) => {
    const imported = specifier.imported as Identifier | null
    const isNamedImport = imported && imported.name !== specifier.local.name
    return isNamedImport ? `${imported.name} as ${specifier.local.name}` : specifier.local.name
  })
}

const UnheadVue = '@unhead/vue'

/**
 * To use composable in an async context we need to pass Nuxt context to the Unhead composables.
 *
 * We swap imports from @unhead/vue to #app/composables/head and warn users for type safety.
 */
// 自动将对 @unhead/vue 的组合式 API 导入，
// 重定向为 #app/composables/head，以支持在 async setup()
// 或 server context 中正确运行，同时提升类型安全。

// 背景知识
// @unhead/vue：是 Nuxt 内部使用的 Head 管理库（用于 useHead() 等 API）。
// #app/composables/head：是 Nuxt 为了兼容 async context，包装后的 @unhead/vue 组合函数代理。
// 问题场景：如果你手动从 @unhead/vue 导入 useHead()，在 SSR 或 async setup() 中可能拿不到正确的上下文（NuxtApp），类型提示也会丢失。
export const UnheadImportsPlugin = (options: UnheadImportsPluginOptions) => createUnplugin(() => {
  return {
    name: 'nuxt:head:unhead-imports',
    enforce: 'post',
    transformInclude (id) {
      id = normalize(id)
      return (
        // 避免处理：
        // node_modules 文件
        // 虚拟模块（virtual:）
        // Nuxt 自己编译产物（distDir）
        (isJS(id) || isVue(id, { type: ['script'] })) &&
        !id.startsWith('virtual:') &&
        !id.startsWith(normalize(distDir)) &&
        !UNHEAD_LIB_RE.test(id)
      )
    },
    transform (code, id) {
      if (!code.includes(UnheadVue)) {
        return
      }
      const s = new MagicString(code)
      const importsToAdd: ImportSpecifier[] = []
      // 遍历 AST，提取导入语句
      parseAndWalk(code, id, function (node) {
        // 查找 import { useHead } from '@unhead/vue'；
        // 收集导入的 specifier（如 useHead, useSeoMeta）；
        // 并将原始导入语句从代码中移除。
        if (node.type === 'ImportDeclaration' && [UnheadVue, '#app/composables/head'].includes(String(node.source.value))) {
          importsToAdd.push(...node.specifiers as ImportSpecifier[])
          const { start, end } = withLocations(node)
          s.remove(start, end)
        }
      })

      const importsFromUnhead = importsToAdd.filter(specifier => unheadVueComposablesImports[UnheadVue].includes((specifier.imported as Identifier)?.name))
      const importsFromHead = importsToAdd.filter(specifier => !unheadVueComposablesImports[UnheadVue].includes((specifier.imported as Identifier)?.name))
      if (importsFromUnhead.length) {
        // warn if user has imported from @unhead/vue themselves
        if (!normalize(id).includes('node_modules')) {
          logger.warn(`You are importing from \`${UnheadVue}\` in \`./${relative(normalize(options.rootDir), normalize(id))}\`. Please import from \`#imports\` instead for full type safety.`)
        }
        s.prepend(`${genImport('#app/composables/head', toImports(importsFromUnhead))}\n`)
      }
      if (importsFromHead.length) {
        s.prepend(`${genImport(UnheadVue, toImports(importsFromHead))}\n`)
      }

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: options.sourcemap
            ? s.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
})
