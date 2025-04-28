import { promises as fsp } from 'node:fs'
// TODO: swap out when https://github.com/lodash/lodash/pull/5649 is merged
import { template as lodashTemplate } from 'lodash-es'
import { genDynamicImport, genImport, genSafeVariableName } from 'knitwork'

import type { NuxtTemplate } from '@nuxt/schema'
import { logger } from '../logger'
import { toArray } from '../utils'

/** @deprecated */
// TODO: Remove support for compiling ejs templates in v4
// 这是一个核心函数。
// 作用是：
// 给定一个 template 对象（符合 NuxtTemplate 类型），
// 读取模板文件 (template.src)，
// 用 lodash.template （一个简单的字符串模板引擎）把模板字符串和传入的数据 (ctx) 渲染成最终字符串。
// 如果没有 src，但 template.getContents 存在，就直接调用 getContents(data)。
// 如果两者都没有，抛出异常。
export async function compileTemplate<T> (template: NuxtTemplate<T>, ctx: any) {
  const data = { ...ctx, options: template.options }
  if (template.src) {
    try {
      const srcContents = await fsp.readFile(template.src, 'utf-8')
      return lodashTemplate(srcContents, {})(data)
    } catch (err) {
      logger.error('Error compiling template: ', template)
      throw err
    }
  }
  if (template.getContents) {
    return template.getContents(data)
  }
  throw new Error('Invalid template: ' + JSON.stringify(template))
}

/** @deprecated */
// 将一个对象序列化成漂亮的 JSON 格式，
// 特别处理了形如 "{"xxx"}" 这种字符串，把它们反序列化为真正的对象代码。
// 用途是把数据变成可插入到源码里的样子。
// 已经标记为废弃。
const serialize = (data: any) => JSON.stringify(data, null, 2).replace(/"\{(.+)\}"(?=,?$)/gm, r => JSON.parse(r).replace(/^\{(.*)\}$/, '$1'))

/** @deprecated */
// 根据一个或多个模块路径，自动生成 import 语句或 dynamic import 语句。
// 支持 lazy = true 参数来控制是静态 import 还是动态 import。
// 动态 import 时带 webpackChunkName 注释。
// 已经标记为废弃。
const importSources = (sources: string | string[], { lazy = false } = {}) => {
  return toArray(sources).map((src) => {
    const safeVariableName = genSafeVariableName(src)
    if (lazy) {
      return `const ${safeVariableName} = ${genDynamicImport(src, { comment: `webpackChunkName: ${JSON.stringify(src)}` })}`
    }
    return genImport(src, safeVariableName)
  }).join('\n')
}

/** @deprecated */
const importName = genSafeVariableName

/** @deprecated */
export const templateUtils = { serialize, importName, importSources }
