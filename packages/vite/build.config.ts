import { defineBuildConfig } from 'unbuild' // 从 'unbuild' 导入 defineBuildConfig 方法，用于定义构建配置
import { addRollupTimingsPlugin, stubOptions } from '../../debug/build-config' // 从本地调试配置模块导入添加插件的方法和 stub 选项

// 使用 defineBuildConfig 导出构建配置对象
export default defineBuildConfig({
  // 启用 TypeScript 类型声明文件生成（即 .d.ts）
  declaration: true,
  // 定义打包入口
  entries: [
    // 第一个入口：打包 src/index.ts 作为默认入口
    'src/index',
    // 第二个入口：将 src/runtime 目录下的所有模块打包到 dist/runtime，输出为 ESM 格式
    { input: 'src/runtime/', outDir: 'dist/runtime', format: 'esm' },
  ],
  // 应用于打包过程的 stub 选项（通常用于 mock 依赖或调试）
  stubOptions,
  // 注册构建钩子
  hooks: {
    // 在 rollup 生成配置时调用，添加自定义 Rollup 插件以记录构建耗时
    'rollup:options' (ctx, options) {
      // 向 Rollup 配置中注入 addRollupTimingsPlugin 插件，用于记录打包时间
      addRollupTimingsPlugin(options)
    },
  },
  // 声明打包时需要处理的依赖（这些依赖会被打进包中）
  dependencies: [
    // 声明 vue 是该包的直接依赖
    'vue',
  ],
  // 声明外部依赖（这些不会被打包进输出文件，而是在运行时从外部引入）
  externals: [
    // 声明 @nuxt/schema 为外部模块，避免重复打包
    '@nuxt/schema',
  ],
})
