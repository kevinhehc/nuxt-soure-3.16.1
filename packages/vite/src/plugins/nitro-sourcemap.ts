import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'pathe'

import type { Plugin as RollupPlugin } from 'rollup'
import type { Plugin as VitePlugin } from 'vite'

// 用于 保留并导出源码映射（source maps） 的插件逻辑
// 目的是在构建时导出 .map 文件并在运行时正确加载
export const createSourcemapPreserver = () => {
  // 用于保存 Vite 构建输出目录的路径
  let outputDir: string
  // 存储生成过 source map 的文件路径（用于后续判断是否加载）
  const ids = new Set<string>()

  // 定义 Vite 插件
  const vitePlugin = {
    // 插件名称（调试或日志中有用）
    name: 'nuxt:sourcemap-export',
    // 当 Vite 的配置解析完成后，会调用此钩子
    configResolved (config) {
      // 获取构建输出目录（如 .output/public）
      outputDir = config.build.outDir
    },

    // 构建产物写入磁盘后执行
    async writeBundle (_options, bundle) {

      // 遍历构建生成的所有文件
      for (const chunk of Object.values(bundle)) {
        // 如果不是代码 chunk 或没有 sourcemap，则跳过
        if (chunk.type !== 'chunk' || !chunk.map) { continue }

        // 生成 chunk 的完整输出路径
        const id = resolve(outputDir, chunk.fileName)
        // 记录该文件路径，后续 nitro 插件会用到
        ids.add(id)
        // 构建 map 文件的目标路径，如 example.js.map.json
        const dest = id + '.map.json'
        // 递归创建目标目录
        await mkdir(dirname(dest), { recursive: true })
        // 将 source map 的结构写入 JSON 文件中
        await writeFile(dest, JSON.stringify({
          file: chunk.map.file,
          mappings: chunk.map.mappings,
          names: chunk.map.names,
          sources: chunk.map.sources,
          sourcesContent: chunk.map.sourcesContent,
          version: chunk.map.version,
        }))
      }
    },
  } satisfies VitePlugin // 类型断言：这是一个 Vite 插件

  // 定义 Nitro 插件（本质是 Rollup 插件）
  const nitroPlugin = {
    name: 'nuxt:sourcemap-import', // 插件名称

    // 当系统尝试加载某个模块文件时，会调用此函数
    async load (id) {
      // 标准化路径格式
      id = resolve(id)
      // 只有是我们记录过的文件才处理
      if (!ids.has(id)) { return }

      // 并行读取源码文件和 source map JSON 文件
      const [code, map] = await Promise.all([
        readFile(id, 'utf-8').catch(() => undefined),
        readFile(id + '.map.json', 'utf-8').catch(() => undefined),
      ])

      // 如果源码读取失败，发出警告
      if (!code) {
        this.warn('Failed loading file')
        return null
      }

      // 返回包含代码和 source map 的对象
      return {
        code,
        map,
      }
    },
  } satisfies RollupPlugin  // 类型断言：这是一个 Rollup 插件

  return {
    vitePlugin, // 用于在 Vite 构建阶段导出 source map 数据
    nitroPlugin, // 用于在 Nitro 构建或运行阶段加载带有 source map 的 JavaScript 文件
  }
}
