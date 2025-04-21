// 从 Nuxt 的 kit 中导入 useNuxt，用于获取 Nuxt 实例
import { useNuxt } from '@nuxt/kit'
// 导入 escape-string-regexp，用于对字符串中的正则特殊字符进行转义
import escapeRegExp from 'escape-string-regexp'
// 导入 pathe 的 normalize 方法，用于统一路径格式（如在不同操作系统下）
import { normalize } from 'pathe'

// 定义一个接口 Envs，表示构建环境相关的信息
interface Envs {
  // 是否是开发环境
  isDev: boolean
  // 是否是客户端（浏览器端）
  isClient?: boolean
  // 是否是服务端（Node.js 端）
  isServer?: boolean
}

// 定义一个名为 transpile 的函数，接收构建环境参数，返回一个包含 string 或 RegExp 的数组
// 在 Nuxt 中，有些第三方包可能默认是用 ES6 或 TypeScript 写的，并没有编译成兼容的 ES5 代码。
// 如果你项目里用到了这些包，而构建工具（如 Vite）不会自动处理它们，就可能导致构建失败或浏览器报错。
// 所以 Nuxt 提供了 build.transpile 配置项，让你可以指定这些包或路径，在构建时额外编译一次（转译）。
export function transpile (envs: Envs): Array<string | RegExp> {
  // 获取 Nuxt 实例，通常用于访问配置项、运行上下文等
  const nuxt = useNuxt()
  // 创建一个空数组，用于存放处理后的正则表达式（最终的 transpile 列表）
  const transpile: RegExp[] = []

  // 遍历 nuxt 配置中的 build.transpile 项（用户定义的需编译处理的模块/路径）
  for (let pattern of nuxt.options.build.transpile) {
    // 如果该项是函数，说明其是动态根据环境返回的路径或正则
    if (typeof pattern === 'function') {
      // 调用该函数，传入当前构建环境
      const result = pattern(envs)
      // 如果有返回值，则更新 pattern 为该返回值
      if (result) { pattern = result }
    }
    // 如果是字符串类型（表示某个模块名或路径）
    if (typeof pattern === 'string') {
      // 对路径进行标准化，并转义后转换为正则表达式加入数组
      transpile.push(new RegExp(escapeRegExp(normalize(pattern))))
      // 如果已经是正则表达式，则直接加入数组
    } else if (pattern instanceof RegExp) {
      transpile.push(pattern)
    }
  }

  // 返回处理后的 transpile 数组（正则表达式数组）
  // 这个数组会被 Vite 或 Webpack 用于决定：
  // 哪些模块我需要额外处理一下，做一次 Babel 转译”，避免运行时报出如下错误： Unexpected token 'export' in node_modules/vee-validate/index.js
  return transpile
}
