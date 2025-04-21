// 从 'pathe' 导入工具函数：relative 用于计算相对路径，resolve 用于解析绝对路径
import { relative, resolve } from 'pathe'
// 用于对字符串进行正则转义，防止特殊字符被当作正则语法处理
import escapeRE from 'escape-string-regexp'
// 引入 NuxtOptions 类型定义，来自 Nuxt 的类型系统
import type { NuxtOptions } from 'nuxt/schema'

// 定义 ImportProtectionOptions 接口，用于配置导入保护规则
interface ImportProtectionOptions {
  // 项目根目录
  rootDir: string
  // 模块目录
  modulesDir: string[]
  // 需要保护的导入模式（正则或字符串）及可选警告信息
  patterns: [importPattern: string | RegExp, warning?: string][]
  // 可选的排除列表，跳过特定文件
  exclude?: Array<RegExp | string>
}

// Nuxt 中用于生成规则时的上下文类型定义
interface NuxtImportProtectionOptions {
  // 指定当前运行环境（客户端、服务端或共享目录）
  context: 'nuxt-app' | 'nitro-app' | 'shared'
}

// 主要功能是生成“导入保护规则”（Import Protection Rules），防止在不适当的上下文中导入特定模块（例如 nuxt, nuxt.config, #app 等），以避免运行时或构建时错误。
// 主函数：根据 Nuxt 实例和运行上下文，生成导入保护的正则匹配规则
export const createImportProtectionPatterns = (
  // 主函数：根据 Nuxt 实例和运行上下文，生成导入保护的正则匹配规则
  nuxt: { options: NuxtOptions },
  // 当前上下文配置
  options: NuxtImportProtectionOptions) => {
  // 初始化规则列表
  const patterns: ImportProtectionOptions['patterns'] = []
  // 获取当前上下文的描述信息
  const context = contextFlags[options.context]

  // 1. 阻止导入 `nuxt`, `nuxt3`, `nuxt-nightly`
  patterns.push([
    /^(nuxt|nuxt3|nuxt-nightly)$/,
    `\`nuxt\`, or \`nuxt-nightly\` cannot be imported directly in ${context}.` + (options.context === 'nuxt-app' ? ' Instead, import runtime Nuxt composables from `#app` or `#imports`.' : ''),
  ])

  // 2. 阻止直接导入 nuxt.config 文件
  patterns.push([
    /^((~|~~|@|@@)?\/)?nuxt\.config(\.|$)/,
    'Importing directly from a `nuxt.config` file is not allowed. Instead, use runtime config or a module.',
  ])

  // 3. 阻止使用 @vue/composition-api（这是 Vue 2 用的，Nuxt 3 是 Vue 3，不兼容）
  patterns.push([/(^|node_modules\/)@vue\/composition-api/])

  // 4. 阻止直接从已安装模块导入（如 nuxt.config 中配置的 modules）
  for (const mod of nuxt.options.modules.filter(m => typeof m === 'string')) {
    patterns.push([
      new RegExp(`^${escapeRE(mod)}$`),
      'Importing directly from module entry-points is not allowed.',
    ])
  }

  // 5. 阻止导入一些开发/构建相关的内部模块
  for (const i of [/(^|node_modules\/)@nuxt\/(cli|kit|test-utils)/, /(^|node_modules\/)nuxi/, /(^|node_modules\/)nitro(?:pack)?(?:-nightly)?(?:$|\/)(?!(?:dist\/)?(?:node_modules|presets|runtime|types))/, /(^|node_modules\/)nuxt\/(config|kit|schema)/]) {
    patterns.push([i, `This module cannot be imported in ${context}.`])
  }

  // 6. 如果当前上下文是 nitro-app 或 shared，禁止使用 Vue 客户端别名（如 #app、#build）
  if (options.context === 'nitro-app' || options.context === 'shared') {
    for (const i of ['#app', /^#build(\/|$)/]) {
      patterns.push([i, `Vue app aliases are not allowed in ${context}.`])
    }
  }

  // 7. 如果当前上下文是 nuxt-app 或 shared，禁止导入 server 目录下的特定内容（如 api, routes, middleware, plugins）
  if (options.context === 'nuxt-app' || options.context === 'shared') {
    patterns.push([
      new RegExp(escapeRE(relative(nuxt.options.srcDir, resolve(nuxt.options.srcDir, nuxt.options.serverDir || 'server'))) + '\\/(api|routes|middleware|plugins)\\/'),
      `Importing from server is not allowed in ${context}.`,
    ])
  }

  // 返回所有构建好的模式
  return patterns
}

// 定义每个 context 的解释说明，用于在警告信息中展示
const contextFlags = {
  // Nitro 服务端运行时
  'nitro-app': 'server runtime',
  // Vue 客户端运行部分
  'nuxt-app': 'the Vue part of your app',
  // shared 文件夹（共享代码）
  'shared': 'the #shared directory',
} as const
