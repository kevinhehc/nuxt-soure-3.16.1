import { resolve } from 'pathe'
import { addBuildPlugin, addComponent, addPlugin, addTemplate, defineNuxtModule, directoryToURL } from '@nuxt/kit'
import type { NuxtOptions } from '@nuxt/schema'
import { resolveModulePath } from 'exsolve'
import { distDir } from '../dirs'
import { UnheadImportsPlugin } from './plugins/unhead-imports'

const components = ['NoScript', 'Link', 'Base', 'Title', 'Meta', 'Style', 'Head', 'Html', 'Body']

// 用于将 @unhead/vue 集成到 Nuxt 应用中，提供 <head> 元信息处理支持（即 useHead()、useSeoMeta() 等），并根据 Nuxt 版本（v3 / v4）做出适配。
export default defineNuxtModule<NuxtOptions['unhead']>({
  // 模块名是 nuxt:meta；
  // Nuxt 配置中用 unhead: { ... } 设置相关选项；
  // 类型安全由 NuxtOptions['unhead'] 提供支持。
  meta: {
    name: 'nuxt:meta',
    configKey: 'unhead',
  },
  setup (options, nuxt) {
    const runtimeDir = resolve(distDir, 'head/runtime')

    // Transpile @unhead/vue
    // 确保 Nuxt 编译时不会跳过 @unhead/vue 中的 ESM 代码（兼容旧环境）。
    nuxt.options.build.transpile.push('@unhead/vue')

    // v4 的插件结构有所不同，后续会影响 composables、插件模板路径等。
    const isNuxtV4 = nuxt.options._majorVersion === 4 || nuxt.options.future?.compatibilityVersion === 4
    // Register components
    const componentsPath = resolve(runtimeDir, 'components')
    // 添加如 <Head>, <Title>, <Meta> 等组件；
    // 来自 @unhead/vue/components；
    // priority: 10 确保不会被用户同名组件覆盖。
    for (const componentName of components) {
      addComponent({
        name: componentName,
        filePath: componentsPath,
        export: componentName,
        // built-in that we do not expect the user to override
        priority: 10,
        // kebab case version of these tags is not valid
        kebabName: componentName,
      })
    }

    // allow @unhead/vue server composables to be tree-shaken from the client bundle
    // 避免把 SSR-only composables 打包进客户端代码；
    // 节省体积，提高性能。
    if (!nuxt.options.dev) {
      nuxt.options.optimization.treeShake.composables.client['@unhead/vue'] = [
        'useServerHead', 'useServerSeoMeta', 'useServerHeadSafe',
      ]
    }

    // 为 Nuxt 提供自动导入时的正确路径；
    // 根据版本区分导入位置。
    nuxt.options.alias['#unhead/composables'] = resolve(runtimeDir, 'composables', isNuxtV4 ? 'v4' : 'v3')
    // 添加构建时 import 替换插件（重要）
    // 自动将用户写的：
    // import { useHead } from '@unhead/vue'
    // 替换为：
    // import { useHead } from '#app/composables/head'
    // 以确保 async context 类型安全运行。
    addBuildPlugin(UnheadImportsPlugin({
      sourcemap: !!nuxt.options.sourcemap.server,
      rootDir: nuxt.options.rootDir,
    }))

    // Opt-out feature allowing dependencies using @vueuse/head to work
    const importPaths = nuxt.options.modulesDir.map(d => directoryToURL(d))
    const unheadPlugins = resolveModulePath('@unhead/vue/plugins', { try: true, from: importPaths }) || '@unhead/vue/plugins'
    // 某些库（如 VueUse）仍依赖 @vueuse/head，这里通过别名转向 @unhead/vue 兼容；
    // 加载一个 polyfill 插件兼容行为差异。
    if (nuxt.options.experimental.polyfillVueUseHead) {
      // backwards compatibility
      nuxt.options.alias['@vueuse/head'] = resolveModulePath('@unhead/vue', { try: true, from: importPaths }) || '@unhead/vue'
      addPlugin({ src: resolve(runtimeDir, 'plugins/vueuse-head-polyfill') })
    }

    // 注册 Unhead 配置模板（用于 SSR）
    // 提供默认插件配置（如 AliasSortingPlugin, TemplateParamsPlugin 等）；
    // 在构建时生成到 #build/unhead-options.mjs。
    addTemplate({
      filename: 'unhead-options.mjs',
      getContents () {
        // disableDefaults is enabled to avoid server component issues
        if (isNuxtV4 && !options.legacy) {
          return `
export default {
  disableDefaults: true,
}`
        }
        // v1 unhead legacy options
        const disableCapoSorting = !nuxt.options.experimental.headNext
        return `import { DeprecationsPlugin, PromisesPlugin, TemplateParamsPlugin, AliasSortingPlugin } from ${JSON.stringify(unheadPlugins)};
export default {
  disableDefaults: true,
  disableCapoSorting: ${Boolean(disableCapoSorting)},
  plugins: [DeprecationsPlugin, PromisesPlugin, TemplateParamsPlugin, AliasSortingPlugin],
}`
      },
    })

    addTemplate({
      filename: 'unhead.config.mjs',
      getContents () {
        return [
          `export const renderSSRHeadOptions = ${JSON.stringify(options.renderSSRHeadOptions || {})}`,
        ].join('\n')
      },
    })

    // template is only exposed in nuxt context, expose in nitro context as well
    // 向 Nitro 暴露 virtual 模块（服务端可访问）
    nuxt.hooks.hook('nitro:config', (config) => {
      config.virtual!['#internal/unhead-options.mjs'] = () => nuxt.vfs['#build/unhead-options.mjs']
      config.virtual!['#internal/unhead.config.mjs'] = () => nuxt.vfs['#build/unhead.config.mjs']
    })

    // Add library-specific plugin
    // 这将注册 useHead()、injectHead() 等上下文内容；
    // 同时处理页面切换时 DOM 更新逻辑。
    addPlugin({ src: resolve(runtimeDir, 'plugins/unhead') })
  },
})
