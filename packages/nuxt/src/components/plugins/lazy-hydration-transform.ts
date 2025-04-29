import { createUnplugin } from 'unplugin'
import MagicString from 'magic-string'
import { camelCase, pascalCase } from 'scule'
import type { Component, ComponentsOptions } from 'nuxt/schema'

import { parse, walk } from 'ultrahtml'
import { isVue } from '../../core/utils'
import { logger } from '../../utils'

interface LoaderOptions {
  getComponents (): Component[]
  sourcemap?: boolean
  transform?: ComponentsOptions['transform']
}

const TEMPLATE_RE = /<template>([\s\S]*)<\/template>/
const hydrationStrategyMap = {
  hydrateOnIdle: 'Idle',
  hydrateOnVisible: 'Visible',
  hydrateOnInteraction: 'Interaction',
  hydrateOnMediaQuery: 'MediaQuery',
  hydrateAfter: 'Time',
  hydrateWhen: 'If',
  hydrateNever: 'Never',
}
const LAZY_HYDRATION_PROPS_RE = /\bhydrate-?on-?idle|hydrate-?on-?visible|hydrate-?on-?interaction|hydrate-?on-?media-?query|hydrate-?after|hydrate-?when|hydrate-?never\b/

// 在编译 .vue 文件时，根据组件上的 hydrate-* 属性，自动切换成对应延迟挂载的 Lazy 组件版本。
// 具体来说，它做了两件事：
// 扫描 <LazyXXX> 组件，如果发现有 hydrate-on-idle、hydrate-on-visible 等属性。
// 把组件名自动替换成 Lazy+策略名+组件名，例如：<LazyMyComponent> ➔ <LazyIdleMyComponent>。
// 这样，Nuxt 就可以根据不同策略（如页面可见、空闲时、点击后等）来 延迟挂载这个组件，而不是一开始就挂载，大大提高性能、加快首屏渲染速度。

// 示例 1：hydrate-on-idle
// 开发者写的 .vue 代码：
// <template>
//   <LazyMyComponent hydrate-on-idle />
// </template>
//
// 经过 LazyHydrationTransformPlugin 处理后，自动变成：
// <template>
//   <LazyIdleMyComponent hydrate-on-idle />
// </template>
//
// 解释：
// hydrate-on-idle ➔ 策略是 Idle
// 所以用 LazyIdleMyComponent，意思是：浏览器空闲时再加载这个组件。


// 示例 2：hydrate-on-visible
// 原始写法：
// <template>
//   <LazyChatWidget hydrate-on-visible />
// </template>
//
// 插件转化后：
// <template>
//   <LazyVisibleChatWidget hydrate-on-visible />
// </template>
//
// 解释：
// hydrate-on-visible ➔ 策略是 Visible
// 意思是：滚动到屏幕看到这个组件的时候再挂载，优化初次加载。

export const LazyHydrationTransformPlugin = (options: LoaderOptions) => createUnplugin(() => {
  const exclude = options.transform?.exclude || []
  const include = options.transform?.include || []

  return {
    name: 'nuxt:components-loader-pre',
    enforce: 'pre',
    transformInclude (id) {
      if (exclude.some(pattern => pattern.test(id))) {
        return false
      }
      if (include.some(pattern => pattern.test(id))) {
        return true
      }
      return isVue(id)
    },
    async transform (code) {
      // change <LazyMyComponent hydrate-on-idle /> to <LazyIdleMyComponent hydrate-on-idle />
      const { 0: template, index: offset = 0 } = code.match(TEMPLATE_RE) || {}
      if (!template) { return }
      if (!LAZY_HYDRATION_PROPS_RE.test(template)) {
        return
      }
      const s = new MagicString(code)
      try {
        const ast = parse(template)
        const components = options.getComponents()
        await walk(ast, (node) => {
          if (node.type !== 1 /* ELEMENT_NODE */) {
            return
          }
          if (!/^(?:Lazy|lazy-)/.test(node.name)) {
            return
          }
          const pascalName = pascalCase(node.name.slice(4))
          if (!components.some(c => c.pascalName === pascalName)) {
            // not auto-imported
            return
          }

          let strategy: string | undefined

          for (const attr in node.attributes) {
            const isDynamic = attr.startsWith(':')
            const prop = camelCase(isDynamic ? attr.slice(1) : attr)
            if (prop in hydrationStrategyMap) {
              if (strategy) {
                logger.warn(`Multiple hydration strategies are not supported in the same component`)
              } else {
                strategy = hydrationStrategyMap[prop as keyof typeof hydrationStrategyMap]
              }
            }
          }

          if (strategy) {
            const newName = 'Lazy' + strategy + pascalName
            const chunk = template.slice(node.loc[0].start, node.loc.at(-1)!.end)
            const chunkOffset = node.loc[0].start + offset
            const { 0: startingChunk, index: startingPoint = 0 } = chunk.match(new RegExp(`<${node.name}[^>]*>`)) || {}
            s.overwrite(startingPoint + chunkOffset, startingPoint + chunkOffset + startingChunk!.length, startingChunk!.replace(node.name, newName))

            const { 0: endingChunk, index: endingPoint } = chunk.match(new RegExp(`<\\/${node.name}[^>]*>$`)) || {}
            if (endingChunk && endingPoint) {
              s.overwrite(endingPoint + chunkOffset, endingPoint + chunkOffset + endingChunk.length, endingChunk.replace(node.name, newName))
            }
          }
        })
      } catch {
        // ignore errors if it's not html-like
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
