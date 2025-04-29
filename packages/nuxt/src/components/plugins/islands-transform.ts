import { pathToFileURL } from 'node:url'
import fs from 'node:fs'
import { join } from 'pathe'
import type { Component } from '@nuxt/schema'
import { parseURL } from 'ufo'
import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import { ELEMENT_NODE, parse, walk } from 'ultrahtml'
import { resolvePath } from '@nuxt/kit'
import defu from 'defu'
import { isVue } from '../../core/utils'

// IslandsTransformPlugin 负责在 .vue 文件中，将 slot 和 带 nuxt-client 属性的元素，自动包裹成特定的 Nuxt 组件，以支持 islands architecture（岛屿架构，小块 SSR+CSR 混合渲染）。


// 示例 1：处理 <slot>
// 原始写法：
// <template>
//   <div>
//     <slot name="footer" />
//   </div>
// </template>
// 经过 IslandsTransformPlugin 处理后，变成：
// <template>
//   <div>
//     <NuxtTeleportSsrSlot name="footer" :props="undefined">
//       <slot name="footer" />
//       <template #fallback>
//         <!-- fallback内容（如果有） -->
//       </template>
//     </NuxtTeleportSsrSlot>
//   </div>
// </template>
//
// 解释：
// <slot> 不直接渲染了。
// 被包在 <NuxtTeleportSsrSlot> 里面，用来在服务端/客户端同步管理 slot 的渲染。
// 如果 slot 里面有 v-for，还会加包装 <div v-for> 来保证循环的正确性。



// 示例 2：处理带 nuxt-client 属性的元素
// 原始写法：
// <template>
//   <div>
//     <FormWizard nuxt-client />
//   </div>
// </template>
// 插件处理后变成：
// <template>
//   <div>
//     <NuxtTeleportIslandComponent :nuxt-client="true">
//       <FormWizard />
//     </NuxtTeleportIslandComponent>
//   </div>
// </template>
//
// 解释：
// 检测到 FormWizard 上有 nuxt-client。
// 自动用 <NuxtTeleportIslandComponent> 包裹。
// 这样这个 FormWizard 只会在浏览器端动态挂载，而不会一开始就出现在服务器渲染内容里。


interface ServerOnlyComponentTransformPluginOptions {
  getComponents: () => Component[]
  /**
   * allow using `nuxt-client` attribute on components
   */
  selectiveClient?: boolean | 'deep'
}

interface ComponentChunkOptions {
  getComponents: () => Component[]
  buildDir: string
}

// SCRIPT_RE：匹配 <script> 标签。
// HAS_SLOT_OR_CLIENT_RE：检查是否有 <slot> 或 nuxt-client 属性。
// TEMPLATE_RE：提取 <template> ... </template> 部分。
// NUXTCLIENT_ATTR_RE：提取 nuxt-client 属性。
// EXTRACTED_ATTRS_RE：提取 v-if, v-else-if, v-else 条件指令。
// KEY_RE：提取 key="xxx"，因为在转移 slot 的时候 key 要特殊处理。
const SCRIPT_RE = /<script[^>]*>/gi
const HAS_SLOT_OR_CLIENT_RE = /<slot[^>]*>|nuxt-client/
const TEMPLATE_RE = /<template>([\s\S]*)<\/template>/
const NUXTCLIENT_ATTR_RE = /\s:?nuxt-client(="[^"]*")?/g
const IMPORT_CODE = '\nimport { mergeProps as __mergeProps } from \'vue\'' + '\nimport { vforToArray as __vforToArray } from \'#app/components/utils\'' + '\nimport NuxtTeleportIslandComponent from \'#app/components/nuxt-teleport-island-component\'' + '\nimport NuxtTeleportSsrSlot from \'#app/components/nuxt-teleport-island-slot\''
const EXTRACTED_ATTRS_RE = /v-(?:if|else-if|else)(="[^"]*")?/g
const KEY_RE = /:?key="[^"]"/g

// 包一层 <div>，用于支持 v-for 并保持 display: contents（不破坏布局）。
function wrapWithVForDiv (code: string, vfor: string): string {
  return `<div v-for="${vfor}" style="display: contents;">${code}</div>`
}

// 处理 .vue 文件中带 <slot> 或 nuxt-client 的情况，改写模板，让组件支持 islands (小块SSR/CSR混合渲染)。
export const IslandsTransformPlugin = (options: ServerOnlyComponentTransformPluginOptions) => createUnplugin((_options, meta) => {
  const isVite = meta.framework === 'vite'
  return {
    name: 'nuxt:server-only-component-transform',
    enforce: 'pre',
    transformInclude (id) {
      // 只处理 .vue 文件。
      // 如果是 Vite 且 selectiveClient 是 deep，直接处理所有 Vue 文件。
      // 否则只处理属于 islands（island = 小SSR单元，或者 server-only 组件没有 client 版）
      if (!isVue(id)) { return false }
      if (isVite && options.selectiveClient === 'deep') { return true }
      const components = options.getComponents()

      const islands = components.filter(component =>
        component.island || (component.mode === 'server' && !components.some(c => c.pascalName === component.pascalName && c.mode === 'client')),
      )
      const { pathname } = parseURL(decodeURIComponent(pathToFileURL(id).href))
      return islands.some(c => c.filePath === pathname)
    },
    async transform (code, id) {
      // 只处理有 <slot> 或 nuxt-client 的文件。
      // 提取出 <template> 部分。
      // 用 MagicString 开始代码变更。
      if (!HAS_SLOT_OR_CLIENT_RE.test(code)) { return }
      const template = code.match(TEMPLATE_RE)
      if (!template) { return }
      const startingIndex = template.index || 0
      const s = new MagicString(code)

      // 如果 <script> 不存在，就插入 import 代码，否则在 <script> 中追加导入。
      if (!code.match(SCRIPT_RE)) {
        s.prepend('<script setup>' + IMPORT_CODE + '</script>')
      } else {
        s.replace(SCRIPT_RE, (full) => {
          return full + IMPORT_CODE
        })
      }

      let hasNuxtClient = false

      const ast = parse(template[0])
      await walk(ast, (node) => {
        if (node.type !== ELEMENT_NODE) {
          return
        }
        if (node.name === 'slot') {
          const { attributes, children, loc } = node

          const slotName = attributes.name ?? 'default'

          if (attributes.name) { delete attributes.name }
          if (attributes['v-bind']) {
            attributes._bind = extractAttributes(attributes, ['v-bind'])['v-bind']!
          }
          const teleportAttributes = extractAttributes(attributes, ['v-if', 'v-else-if', 'v-else'])
          const bindings = getPropsToString(attributes)
          // add the wrapper
          s.appendLeft(startingIndex + loc[0].start, `<NuxtTeleportSsrSlot${attributeToString(teleportAttributes)} name="${slotName}" :props="${bindings}">`)

          if (children.length) {
            // pass slot fallback to NuxtTeleportSsrSlot fallback
            const attrString = attributeToString(attributes)
            const slice = code.slice(startingIndex + loc[0].end, startingIndex + loc[1].start).replaceAll(KEY_RE, '')
            s.overwrite(startingIndex + loc[0].start, startingIndex + loc[1].end, `<slot${attrString.replaceAll(EXTRACTED_ATTRS_RE, '')}/><template #fallback>${attributes['v-for'] ? wrapWithVForDiv(slice, attributes['v-for']) : slice}</template>`)
          } else {
            s.overwrite(startingIndex + loc[0].start, startingIndex + loc[0].end, code.slice(startingIndex + loc[0].start, startingIndex + loc[0].end).replaceAll(EXTRACTED_ATTRS_RE, ''))
          }

          s.appendRight(startingIndex + loc[1].end, '</NuxtTeleportSsrSlot>')
          return
        }

        if (!('nuxt-client' in node.attributes) && !(':nuxt-client' in node.attributes)) {
          return
        }

        hasNuxtClient = true

        if (!isVite || !options.selectiveClient) {
          return
        }

        const { loc, attributes } = node
        const attributeValue = attributes[':nuxt-client'] || attributes['nuxt-client'] || 'true'
        const wrapperAttributes = extractAttributes(attributes, ['v-if', 'v-else-if', 'v-else'])

        let startTag = code.slice(startingIndex + loc[0].start, startingIndex + loc[0].end).replace(NUXTCLIENT_ATTR_RE, '')
        if (wrapperAttributes) {
          startTag = startTag.replaceAll(EXTRACTED_ATTRS_RE, '')
        }

        s.appendLeft(startingIndex + loc[0].start, `<NuxtTeleportIslandComponent${attributeToString(wrapperAttributes)} :nuxt-client="${attributeValue}">`)
        s.overwrite(startingIndex + loc[0].start, startingIndex + loc[0].end, startTag)
        s.appendRight(startingIndex + loc[1].end, '</NuxtTeleportIslandComponent>')
      })

      if (hasNuxtClient) {
        if (!options.selectiveClient) {
          console.warn(`The \`nuxt-client\` attribute and client components within islands are only supported when \`experimental.componentIslands.selectiveClient\` is enabled. file: ${id}`)
        } else if (!isVite) {
          console.warn(`The \`nuxt-client\` attribute and client components within islands are only supported with Vite. file: ${id}`)
        }
      }

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: s.generateMap({ source: id, includeContent: true }),
        }
      }
    },
  }
})

/**
 * extract attributes from a node
 */
function extractAttributes (attributes: Record<string, string>, names: string[]) {
  const extracted: Record<string, string> = {}
  for (const name of names) {
    if (name in attributes) {
      extracted[name] = attributes[name]!
      delete attributes[name]
    }
  }
  return extracted
}

function attributeToString (attributes: Record<string, string>) {
  return Object.entries(attributes).map(([name, value]) => value ? ` ${name}="${value}"` : ` ${name}`).join('')
}

function isBinding (attr: string): boolean {
  return attr.startsWith(':')
}

function getPropsToString (bindings: Record<string, string>): string {
  const vfor = bindings['v-for']?.split(' in ').map((v: string) => v.trim()) as [string, string] | undefined
  if (Object.keys(bindings).length === 0) { return 'undefined' }
  const content = Object.entries(bindings).filter(b => b[0] && (b[0] !== '_bind' && b[0] !== 'v-for')).map(([name, value]) => isBinding(name) ? `[\`${name.slice(1)}\`]: ${value}` : `[\`${name}\`]: \`${value}\``).join(',')
  const data = bindings._bind ? `__mergeProps(${bindings._bind}, { ${content} })` : `{ ${content} }`
  if (!vfor) {
    return `[${data}]`
  } else {
    return `__vforToArray(${vfor[1]}).map(${vfor[0]} => (${data}))`
  }
}

// 在 Nuxt 打包阶段，把所有 client 或 all 模式的组件，单独打成独立的 JavaScript chunk，并生成一个路径映射表。
// 功能	说明	为什么要做
// 1	把每个 mode: 'client' 或 mode: 'all' 的组件，设成 Rollup/Vite 的独立 entry	这样每个组件都会单独打一个小包，不混在主 bundle 里
// 2	在 generateBundle 时，收集打包后每个组件对应的 chunk 文件路径	用于后续动态按需加载
// 3	写一个 components-chunk.mjs 文件，导出 {组件名: 文件路径} 的对象	供 Nuxt runtime 在客户端需要时动态加载组件
export const ComponentsChunkPlugin = createUnplugin((options: ComponentChunkOptions) => {

  // 为什么很重要？
  // 传统打包方式下，所有组件都打进主 bundle，即使某些组件只在客户端用，也会导致：
  // 首屏下载变慢
  // 服务器渲染加载无用代码
  // 而 ComponentsChunkPlugin 实现了真正的：
  // 按需按场景加载组件（特别是 client-only 组件）
  // 大大减小初始页面大小
  // 提升 FCP（First Contentful Paint）性能指标
  // 尤其配合 IslandsTransformPlugin 和 LazyHydrationTransformPlugin，可以做到 Nuxt 3 的终极优化目标：
  // "服务器快速渲染，浏览器按需激活" 🔥
  const { buildDir } = options
  return {
    name: 'nuxt:components-chunk',
    vite: {
      async config (config) {
        const components = options.getComponents()

        config.build = defu(config.build, {
          rollupOptions: {
            input: {},
            output: {},
          },
        })

        const rollupOptions = config.build.rollupOptions!

        if (typeof rollupOptions.input === 'string') {
          rollupOptions.input = { entry: rollupOptions.input }
        } else if (typeof rollupOptions.input === 'object' && Array.isArray(rollupOptions.input)) {
          rollupOptions.input = rollupOptions.input.reduce<{ [key: string]: string }>((acc, input) => { acc[input] = input; return acc }, {})
        }

        // don't use 'strict', this would create another "facade" chunk for the entry file, causing the ssr styles to not detect everything
        rollupOptions.preserveEntrySignatures = 'allow-extension'
        for (const component of components) {
          if (component.mode === 'client' || component.mode === 'all') {
            rollupOptions.input![component.pascalName] = await resolvePath(component.filePath)
          }
        }
      },

      async generateBundle (_opts, bundle) {
        const components = options.getComponents().filter(c => c.mode === 'client' || c.mode === 'all')
        const pathAssociation: Record<string, string> = {}
        for (const [chunkPath, chunkInfo] of Object.entries(bundle)) {
          if (chunkInfo.type !== 'chunk') { continue }

          for (const component of components) {
            if (chunkInfo.facadeModuleId && chunkInfo.exports.length > 0) {
              const { pathname } = parseURL(decodeURIComponent(pathToFileURL(chunkInfo.facadeModuleId).href))
              const isPath = await resolvePath(component.filePath) === pathname
              if (isPath) {
                // avoid importing the component chunk in all pages
                chunkInfo.isEntry = false
                pathAssociation[component.pascalName] = chunkPath
              }
            }
          }
        }

        fs.writeFileSync(join(buildDir, 'components-chunk.mjs'), `export const paths = ${JSON.stringify(pathAssociation, null, 2)}`)
      },
    },
  }
})
