import type { Plugin } from 'vite'
import { transform } from 'esbuild'
// 用于生成可视化 HTML 报告，展示各个模块占用的大小（图表形式）。
import { visualizer } from 'rollup-plugin-visualizer'
// defu 用于合并默认配置和用户自定义配置，保持结构不变但合并属性。
import defu from 'defu'
import type { NuxtOptions } from 'nuxt/schema'
import type { RenderedModule } from 'rollup'
import type { ViteBuildContext } from '../vite'

export function analyzePlugin (ctx: ViteBuildContext): Plugin[] {
  const analyzeOptions = defu({}, ctx.nuxt.options.build.analyze) as Exclude<NuxtOptions['build']['analyze'], boolean>
  // 获取 Nuxt 配置中的 build.analyze 选项并进行处理。只有当 enabled: true 时才会启用分析插件。
  if (!analyzeOptions.enabled) { return [] }

  return [
    {
      name: 'nuxt:analyze-minify',
      async generateBundle (_opts, outputBundle) {
        // 遍历每个输出的 chunk（代码块）
        for (const _bundleId in outputBundle) {
          const bundle = outputBundle[_bundleId]
          if (!bundle || bundle.type !== 'chunk') { continue }
          const minifiedModuleEntryPromises: Array<Promise<[string, RenderedModule]>> = []
          for (const [moduleId, module] of Object.entries(bundle.modules)) {
            minifiedModuleEntryPromises.push(
              // 针对其中的每个模块代码，用 esbuild 进行压缩（minify）
              transform(module.code || '', { minify: true })
                .then(result => [moduleId, { ...module, code: result.code }]),
            )
          }
          // 替换原来的模块代码为压缩后的内容
          bundle.modules = Object.fromEntries(await Promise.all(minifiedModuleEntryPromises))
        }
      },
    },
    // 使用 visualizer 插件生成 HTML 报告
    // 这个报告可以显示各模块的大小、压缩后大小、结构依赖等
    // 支持 gzipSize: true，展示 gzip 压缩后的大小
    // filename 可以自定义文件名，例如 stats-client.html
    visualizer({
      ...analyzeOptions,
      filename: 'filename' in analyzeOptions ? analyzeOptions.filename!.replace('{name}', 'client') : undefined,
      title: 'Client bundle stats',
      gzipSize: true,
    }),
  ]
}
