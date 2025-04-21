// 引入 Nuxt 框架相关的类型定义（Nuxt 实例 和 配置项）
import type { Nuxt, NuxtOptions } from '@nuxt/schema'
// 引入 Vite 配置中的 InlineConfig 类型，用于指定 CSS 配置的结构
import type { InlineConfig as ViteConfig } from 'vite'
// 引入 PostCSS 插件类型，用于类型提示插件结构
import type { Plugin } from 'postcss'
// 引入 JITI 动态导入工具，可用于在运行时加载模块
import { createJiti } from 'jiti'

/**
 * 对 postcss 插件进行排序
 * @param plugins Nuxt 配置中的 postcss 配置
 * @returns 排序后的插件名称数组
 */
function sortPlugins ({ plugins, order }: NuxtOptions['postcss']): string[] {
  // 获取 postcss 中所有插件的名字
  const names = Object.keys(plugins)
  // 如果配置中指定了排序函数，则使用它；否则使用 order 数组或原始顺序
  return typeof order === 'function' ? order(names) : (order || names)
}


/**
 * 解析 Nuxt 项目的 CSS 配置（用于传递给 Vite）
 * 动态加载 postcss 插件并生成插件数组
 * @param nuxt Nuxt 实例
 * @returns 一个 Promise，解析出 Vite 所需的 CSS 配置
 */
export async function resolveCSSOptions (nuxt: Nuxt): Promise<ViteConfig['css']> {
  // 初始化 CSS 配置结构，其中包含 postcss 插件数组
  const css: ViteConfig['css'] & { postcss: NonNullable<Exclude<NonNullable<ViteConfig['css']>['postcss'], string>> & { plugins: Plugin[] } } = {
    postcss: {
      plugins: [],// 初始化插件为空数组
    },
  }

  // 从 Nuxt 配置中获取 postcss 的配置项
  const postcssOptions = nuxt.options.postcss

  // 创建 JITI 实例用于动态导入插件，指定根目录与 alias
  const jiti = createJiti(nuxt.options.rootDir, { alias: nuxt.options.alias })

  // 遍历排序后的插件名称
  for (const pluginName of sortPlugins(postcssOptions)) {
    // 获取当前插件的配置项（可以是对象或 true）
    const pluginOptions = postcssOptions.plugins[pluginName]
    // 如果插件配置不存在（如 false），则跳过
    if (!pluginOptions) { continue }

    let pluginFn: ((opts: Record<string, any>) => Plugin) | undefined
    // 遍历 modulesDir（用于支持多路径寻找插件），逐个尝试导入插件
    for (const parentURL of nuxt.options.modulesDir) {
      // 使用 JITI 动态导入插件，允许使用默认导出
      pluginFn = await jiti.import(pluginName, {
        // 移除末尾的 node_modules 以便更好地定位插件
        parentURL: parentURL.replace(
          /\/node_modules\/?$/, ''),
        try: true, // 尝试导入（不会抛错）
        default: true // 如果模块是 default 导出，则直接获取
      }) as (opts: Record<string, any>) => Plugin

      // 如果成功导入并且是函数（插件工厂函数）
      if (typeof pluginFn === 'function') {
        // 调用插件工厂函数并传入配置，添加到插件数组中
        css.postcss.plugins.push(pluginFn(pluginOptions))
        // 成功导入则跳出循环
        break
      }
    }

    // 如果所有路径都无法导入插件，输出警告信息
    if (typeof pluginFn !== 'function') {
      console.warn(`[nuxt] could not import postcss plugin \`${pluginName}\`. Please report this as a bug.`)
    }
  }

  // 返回构建好的 Vite CSS 配置对象
  return css
}
