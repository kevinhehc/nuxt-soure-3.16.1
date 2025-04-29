import { isAbsolute, relative } from 'pathe'
import { genDynamicImport } from 'knitwork'
import type { NuxtPluginTemplate, NuxtTemplate } from 'nuxt/schema'

// .vue 组件 -> 扫描 -> app.components
//              ↓
//         ┌────────────────────────────┐
//         │ 自动生成 template 文件：   │
//         │                            │
//         │ components.plugin.mjs      │ ← 全局注册
//         │ component-names.mjs        │ ← 名字列表
//         │ components.islands.mjs     │ ← Island 映射
//         │ components.d.ts            │ ← TS 类型
//         │ components.json            │ ← 元数据       │
//         └────────────────────────────┘
//              ↓
//         供 Nuxt runtime / devtools / ts 使用

type ImportMagicCommentsOptions = {
  chunkName: string
  prefetch?: boolean | number
  preload?: boolean | number
}

// // 生成 webpack magic comments（控制 chunk 名、预加载）
const createImportMagicComments = (options: ImportMagicCommentsOptions) => {
  const { chunkName, prefetch, preload } = options
  return [
    `webpackChunkName: "${chunkName}"`,
    prefetch === true || typeof prefetch === 'number' ? `webpackPrefetch: ${prefetch}` : false,
    preload === true || typeof preload === 'number' ? `webpackPreload: ${preload}` : false,
  ].filter(Boolean).join(', ')
  // => webpackChunkName: "LazyHeader", webpackPreload: true, webpackPrefetch: 0
}

const emptyComponentsPlugin = `
import { defineNuxtPlugin } from '#app/nuxt'
export default defineNuxtPlugin({
  name: 'nuxt:global-components',
})
`

// 注册全局组件
// 生成：components.plugin.mjs
// 自动注册所有 global/sync 组件，无需手动 app.component()。
export const componentsPluginTemplate: NuxtPluginTemplate = {
  filename: 'components.plugin.mjs',
  getContents ({ app }) {
    const lazyGlobalComponents = new Set<string>()
    const syncGlobalComponents = new Set<string>()
    for (const component of app.components) {
      if (component.global === 'sync') {
        syncGlobalComponents.add(component.pascalName)
      } else if (component.global) {
        lazyGlobalComponents.add(component.pascalName)
      }
    }
    if (!lazyGlobalComponents.size && !syncGlobalComponents.size) { return emptyComponentsPlugin }

    const lazyComponents = [...lazyGlobalComponents]
    const syncComponents = [...syncGlobalComponents]

    return `import { defineNuxtPlugin } from '#app/nuxt'
import { ${[...lazyComponents.map(c => 'Lazy' + c), ...syncComponents].join(', ')} } from '#components'
const lazyGlobalComponents = [
  ${lazyComponents.map(c => `["${c}", Lazy${c}]`).join(',\n')},
  ${syncComponents.map(c => `["${c}", ${c}]`).join(',\n')}
]

export default defineNuxtPlugin({
  name: 'nuxt:global-components',
  setup (nuxtApp) {
    for (const [name, component] of lazyGlobalComponents) {
      nuxtApp.vueApp.component(name, component)
      nuxtApp.vueApp.component('Lazy' + name, component)
    }
  }
})
`
  },
}

// 生成组件名称列表
// 用于开发工具、自动补全、chunk 路径映射。
// 生成：component-names.mjs
export const componentNamesTemplate: NuxtTemplate = {
  filename: 'component-names.mjs',
  getContents ({ app }) {
    return `export const componentNames = ${JSON.stringify(app.components.filter(c => !c.island).map(c => c.pascalName))}`
  },
}

// 生成 islands 映射文件
// 生成：components.islands.mjs
// 支持 islands 架构，自动将 .server 组件和 island: true 标记的组件做成 服务端异步组件，用于
export const componentsIslandsTemplate: NuxtTemplate = {
  // components.islands.mjs'
  getContents ({ app, nuxt }) {
    if (!nuxt.options.experimental.componentIslands) {
      return 'export const islandComponents = {}'
    }

    const components = app.components
    const pages = app.pages
    const islands = components.filter(component =>
      component.island ||
      // .server components without a corresponding .client component will need to be rendered as an island
      (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client')),
    )

    const pageExports = pages?.filter(p => (p.mode === 'server' && p.file && p.name)).map((p) => {
      return `"page_${p.name}": defineAsyncComponent(${genDynamicImport(p.file!)}.then(c => c.default || c))`
    }) || []

    return [
      'import { defineAsyncComponent } from \'vue\'',
      'export const islandComponents = import.meta.client ? {} : {',
      islands.map(
        (c) => {
          const exp = c.export === 'default' ? 'c.default || c' : `c['${c.export}']`
          const comment = createImportMagicComments(c)
          return `  "${c.pascalName}": defineAsyncComponent(${genDynamicImport(c.filePath, { comment })}.then(c => ${exp}))`
        },
      ).concat(pageExports).join(',\n'),
      '}',
    ].join('\n')
  },
}

const NON_VUE_RE = /\b\.(?!vue)\w+$/g
// 生成 TypeScript 类型
// 生成：components.d.ts
// 提供全局组件类型定义、lazy 组件支持、island 类型支持。
// 示例：在组件中使用自动导入时，TS 会自动提示组件类型。
export const componentsTypeTemplate = {
  filename: 'components.d.ts' as const,
  getContents: ({ app, nuxt }) => {
    const buildDir = nuxt.options.buildDir
    const componentTypes = app.components.filter(c => !c.island).map((c) => {
      const type = `typeof ${genDynamicImport(isAbsolute(c.filePath)
        ? relative(buildDir, c.filePath).replace(NON_VUE_RE, '')
        : c.filePath.replace(NON_VUE_RE, ''), { wrapper: false })}['${c.export}']`
      return [
        c.pascalName,
        c.island || c.mode === 'server' ? `IslandComponent<${type}>` : type,
      ]
    })
    const islandType = 'type IslandComponent<T extends DefineComponent> = T & DefineComponent<{}, {refresh: () => Promise<void>}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, SlotsType<{ fallback: { error: unknown } }>>'
    return `
import type { DefineComponent, SlotsType } from 'vue'
${nuxt.options.experimental.componentIslands ? islandType : ''}
type HydrationStrategies = {
  hydrateOnVisible?: IntersectionObserverInit | true
  hydrateOnIdle?: number | true
  hydrateOnInteraction?: keyof HTMLElementEventMap | Array<keyof HTMLElementEventMap> | true
  hydrateOnMediaQuery?: string
  hydrateAfter?: number
  hydrateWhen?: boolean
  hydrateNever?: true
}
type LazyComponent<T> = (T & DefineComponent<HydrationStrategies, {}, {}, {}, {}, {}, {}, { hydrated: () => void }>)
interface _GlobalComponents {
  ${componentTypes.map(([pascalName, type]) => `    '${pascalName}': ${type}`).join('\n')}
  ${componentTypes.map(([pascalName, type]) => `    'Lazy${pascalName}': LazyComponent<${type}>`).join('\n')}
}

declare module 'vue' {
  export interface GlobalComponents extends _GlobalComponents { }
}

${componentTypes.map(([pascalName, type]) => `export const ${pascalName}: ${type}`).join('\n')}
${componentTypes.map(([pascalName, type]) => `export const Lazy${pascalName}: LazyComponent<${type}>`).join('\n')}

export const componentNames: string[]
`
  },
} satisfies NuxtTemplate

// 用于开发工具、调试器（如 Nuxt DevTools）读取组件状态。
export const componentsMetadataTemplate: NuxtTemplate = {
  filename: 'components.json',
  write: true,
  getContents: ({ app }) => JSON.stringify(app.components, null, 2),
}
