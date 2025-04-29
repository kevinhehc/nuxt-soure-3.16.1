import { createUnplugin } from 'unplugin'
import type { Unimport } from 'unimport'
import { normalize } from 'pathe'
import { tryUseNuxt } from '@nuxt/kit'
import type { ImportsOptions } from 'nuxt/schema'
import { isJS, isVue } from '../core/utils'

const NODE_MODULES_RE = /[\\/]node_modules[\\/]/
const IMPORTS_RE = /(['"])#imports\1/

// 会在构建时 自动分析和修改 .vue 或 .js 文件中的代码，
// 注入 Nuxt 中注册的 自动导入变量（例如：useRouter, useFetch, ref 等），让你在项目中无需显式 import 就能使用它们。

// Your .vue file
// ↓
// <template> uses `useRoute`, `ref`, `computed`
// ↓
// TransformPlugin → ctx.injectImports()
// ↓
// [unimport] 解析 AST，发现未 import 的变量
// ↓
// 查 ctx.imports（已注册自动导入）
// ↓
// 补全 import { xxx } from '#imports'
// ↓
// '#imports' → 映射到 `.nuxt/imports.mjs`
// ↓
// 实际导入 vue/vue-router/nuxt composables

export const TransformPlugin = ({ ctx, options, sourcemap }: { ctx: Unimport, options: Partial<ImportsOptions>, sourcemap?: boolean }) => createUnplugin(() => {
  return {
    name: 'nuxt:imports-transform',
    enforce: 'post',
    transformInclude (id) {
      // Included
      // 如果手动 include 就处理
      if (options.transform?.include?.some(pattern => pattern.test(id))) {
        return true
      }
      // Excluded
      // 如果手动 exclude 就跳过
      if (options.transform?.exclude?.some(pattern => pattern.test(id))) {
        return false
      }

      // Vue files
      // 是 Vue 文件（.vue）就处理
      if (isVue(id, { type: ['script', 'template'] })) {
        return true
      }

      // JavaScript files
      // 是 JS 文件就处理
      return isJS(id)
    },

    // 实际的代码注入逻辑
    async transform (code, id) {
      id = normalize(id)
      const isNodeModule = NODE_MODULES_RE.test(id) && !options.transform?.include?.some(pattern => pattern.test(id))
      // For modules in node_modules, we only transform `#imports` but not doing imports
      // 对于 node_modules 的代码：
      // 如果它有 #imports 路径引用，也会做 minimal transform；
      // 否则跳过，不做注入，防止改动外部库。
      if (isNodeModule && !IMPORTS_RE.test(code)) {
        return
      }

      // 分析代码中用到但没有 import 的变量（比如 useRoute, ref）
      // 查找是否在 nuxt.config.ts > imports 配置中定义了自动导入
      // 生成对应的 import 语句并注入
      const { s, imports } = await ctx.injectImports(code, id, { autoImport: options.autoImport && !isNodeModule })

      // 背后依赖的库：@unjs/unimport
      // Nuxt 使用 unimport 来完成代码分析、注入、自动导入上下文等，配合 Vite/Webpack 插件钩子插入构建流程。

      // 懒安装 @nuxt/scripts 模块（仅开发调试相关）
      if (imports.some(i => i.from === '#app/composables/script-stubs') && tryUseNuxt()?.options.test === false) {
        //  // 如果用了 `<script setup>` 模拟 API 且不是测试环境，则自动安装 scripts 模块
        import('../core/features').then(({ installNuxtModule }) => installNuxtModule('@nuxt/scripts'))
      }

      if (s.hasChanged()) {
        return {
          code: s.toString(),
          map: sourcemap
            ? s.generateMap({ hires: true })
            : undefined,
        }
      }
    },
  }
})
