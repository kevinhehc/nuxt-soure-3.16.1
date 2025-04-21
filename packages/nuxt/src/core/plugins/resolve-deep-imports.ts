// 从 mlly 包中导入用于解析 node 模块路径的工具函数
import { parseNodeModulePath } from 'mlly'
// 从 exsolve 包中导入用于解析模块路径的方法
import { resolveModulePath } from 'exsolve'
// 导入 pathe 提供的路径处理方法：判断是否为绝对路径、标准化路径、拼接路径
import { isAbsolute, normalize, resolve } from 'pathe'
// 导入 Vite 插件类型定义
import type { Plugin } from 'vite'
// 导入 Nuxt 提供的路径工具方法
import { directoryToURL, resolveAlias } from '@nuxt/kit'
// 导入 Nuxt 的类型定义
import type { Nuxt } from '@nuxt/schema'

// 导入包的根目录路径（pkgDir 是 Nuxt 根目录或 fallback 目录）
import { pkgDir } from '../../dirs'
// 导入 Nuxt 自带的日志工具
import { logger } from '../../utils'

// 用于匹配 Vite 虚拟模块的正则表达式
const VIRTUAL_RE = /^\0?virtual:(?:nuxt:)?/

// 定义并导出一个 Vite 插件，用于解析裸模块和模板导入
export function ResolveDeepImportsPlugin (nuxt: Nuxt): Plugin {
  // 设置不需要处理的导入前缀，避免重复解析或错误解析
  const exclude: string[] = ['virtual:', '\0virtual:', '/__skip_vite', '@vitest/']
  // 将用于模块条件解析的条件集合初始化为空
  let conditions: string[]

  return {
    // 插件名称
    name: 'nuxt:resolve-bare-imports',
    // 插件执行顺序，'post' 意味着在其他插件之后执行
    enforce: 'post',
    // 当 Vite 配置被解析后执行，用于设定解析条件
    configResolved (config) {
      const resolvedConditions = new Set([nuxt.options.dev ? 'development' : 'production', ...config.resolve.conditions])
      // 针对浏览器平台补充条件
      if (resolvedConditions.has('browser')) {
        resolvedConditions.add('web')
        resolvedConditions.add('import')
        resolvedConditions.add('module')
        resolvedConditions.add('default')
      }
      // 如果是测试模式，也加入一些额外条件
      if (config.mode === 'test') {
        resolvedConditions.add('import')
        resolvedConditions.add('require')
      }
      // 最终条件数组
      conditions = [...resolvedConditions]
    },
    // 主要的模块解析逻辑
    async resolveId (id, importer) {
      // 如果没有 importer，或者是绝对路径，或者 importer 不是虚拟模块，或者命中 exclude 列表，则跳过解析
      if (!importer || isAbsolute(id) || (!isAbsolute(importer) && !VIRTUAL_RE.test(importer)) || exclude.some(e => id.startsWith(e))) {
        return
      }

      // 解析别名，获取标准化 id
      const normalisedId = resolveAlias(normalize(id), nuxt.options.alias)
      // 检查是否是 Nuxt 模板虚拟模块导入
      const isNuxtTemplate = importer.startsWith('virtual:nuxt')
      // 对 importer 做标准化处理（去除虚拟前缀）
      const normalisedImporter = (isNuxtTemplate ? decodeURIComponent(importer) : importer).replace(VIRTUAL_RE, '')

      // Nuxt 实验性功能：从模板文件中解析导入路径
      if (nuxt.options.experimental.templateImportResolution !== false && isNuxtTemplate) {
        const template = nuxt.options.build.templates.find(t => resolve(nuxt.options.buildDir, t.filename!) === normalisedImporter)
        // 如果模板路径存在，尝试使用 Vite 内置解析器进行解析
        if (template?._path) {
          const res = await this.resolve?.(normalisedId, template._path, { skipSelf: true })
          if (res !== undefined && res !== null) {
            return res
          }
        }
      }

      // 获取导入者的 node_modules 目录或默认包根目录
      const dir = parseNodeModulePath(normalisedImporter).dir || pkgDir

      // 再次尝试使用 Vite 的解析方法解析模块
      const res = await this.resolve?.(normalisedId, dir, { skipSelf: true })
      if (res !== undefined && res !== null) {
        return res
      }

      // 使用 exsolve 的解析逻辑，进一步尝试解决裸模块导入
      const path = resolveModulePath(id, {
        from: [dir, ...nuxt.options.modulesDir].map(d => directoryToURL(d)),
        suffixes: ['', 'index'],// 可匹配的文件后缀
        conditions,// 条件配置
        try: true, // 不抛错，只尝试
      })

      // 如果仍然找不到路径，记录 debug 日志
      if (!path) {
        logger.debug('Could not resolve id', id, importer)
        return null
      }

      // 返回标准化路径
      return normalize(path)
    },
  }
}
