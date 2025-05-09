import { readdir } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'pathe'
import { globby } from 'globby'
import { kebabCase, pascalCase, splitByCase } from 'scule'
import { isIgnored, useNuxt } from '@nuxt/kit'
import { withTrailingSlash } from 'ufo'
import type { Component, ComponentsDir } from 'nuxt/schema'

import { QUOTE_RE, resolveComponentNameSegments } from '../core/utils'
import { logger } from '../utils'

const ISLAND_RE = /\.island(?:\.global)?$/
const GLOBAL_RE = /\.global(?:\.island)?$/
const COMPONENT_MODE_RE = /(?<=\.)(client|server)(\.global|\.island)*$/
const MODE_REPLACEMENT_RE = /(\.(client|server))?(\.global|\.island)*$/
/**
 * Scan the components inside different components folders
 * and return a unique list of components
 * @param dirs all folders where components are defined
 * @param srcDir src path of your app
 * @returns {Promise} Component found promise
 */
// 扫描组件

// components/
//   ↓
// scanComponents(dirs)
//   ↓
//  ┌──────────────┐
//  │ globby 找文件 │
//  └──────────────┘
//   ↓
//  ┌────────────────────────────────┐
//  │ 根据文件名 → 获取模式、名字等 │
//  └────────────────────────────────┘
//   ↓
//  ┌──────────────────────┐
//  │ 处理冲突、去重、排序 │
//  └──────────────────────┘
//   ↓
// 返回 Component[] 数组（用于注册 + 构建 chunk + 懒加载等）
export async function scanComponents (dirs: ComponentsDir[], srcDir: string): Promise<Component[]> {
  // All scanned components
  const components: Component[] = []

  // Keep resolved path to avoid duplicates
  const filePaths = new Set<string>()

  // All scanned paths
  const scannedPaths: string[] = []

  for (const dir of dirs) {
    if (dir.enabled === false) {
      continue
    }
    // A map from resolved path to component name (used for making duplicate warning message)
    const resolvedNames = new Map<string, string>()

    // globby 是一个比 glob 更强的文件匹配工具，它默认支持递归子目录，按你给的 pattern 去匹配所有符合条件的文件。
    // 而在 normalizeDirs() 那一层就设置好了默认的扫描 pattern：
    // pattern: `**/*.{vue,ts,js}`
    // 这里的 **/ 就代表 任意层级递归扫描，比如：
    // components/
    // ├─ Header.vue
    // ├─ nested/
    // │   ├─ Sidebar.vue
    // │   └─ even-deeper/
    // │       └─ Chart.vue
    // 它们都会被找出来！

    const files = (await globby(dir.pattern!, { cwd: dir.path, ignore: dir.ignore })).sort()

    // Check if the directory exists (globby will otherwise read it case insensitively on MacOS)
    if (files.length) {
      const siblings = await readdir(dirname(dir.path)).catch(() => [] as string[])

      const directory = basename(dir.path)
      if (!siblings.includes(directory)) {
        const directoryLowerCase = directory.toLowerCase()
        const caseCorrected = siblings.find(sibling => sibling.toLowerCase() === directoryLowerCase)
        if (caseCorrected) {
          const nuxt = useNuxt()
          const original = relative(nuxt.options.srcDir, dir.path)
          const corrected = relative(nuxt.options.srcDir, join(dirname(dir.path), caseCorrected))
          logger.warn(`Components not scanned from \`~/${corrected}\`. Did you mean to name the directory \`~/${original}\` instead?`)
          continue
        }
      }
    }

    for (const _file of files) {
      const filePath = join(dir.path, _file)

      if (scannedPaths.find(d => filePath.startsWith(withTrailingSlash(d))) || isIgnored(filePath)) {
        continue
      }

      // Avoid duplicate paths
      if (filePaths.has(filePath)) { continue }

      filePaths.add(filePath)

      /**
       * Create an array of prefixes base on the prefix config
       * Empty prefix will be an empty array
       * @example prefix: 'nuxt' -> ['nuxt']
       * @example prefix: 'nuxt-test' -> ['nuxt', 'test']
       */
      const prefixParts = ([] as string[]).concat(
        dir.prefix ? splitByCase(dir.prefix) : [],
        (dir.pathPrefix !== false) ? splitByCase(relative(dir.path, dirname(filePath))) : [],
      )

      /**
       * In case we have index as filename the component become the parent path
       * @example third-components/index.vue -> third-component
       * if not take the filename
       * @example third-components/Awesome.vue -> Awesome
       */
      let fileName = basename(filePath, extname(filePath))

      const island = ISLAND_RE.test(fileName) || dir.island
      const global = GLOBAL_RE.test(fileName) || dir.global
      // 文件名后缀决定组件加载模式：
      // .client.vue → mode: 'client'
      // .server.vue → mode: 'server'
      // 无后缀 → mode: 'all'
      // 如果是 island（目录或文件名匹配），则自动设为 mode: 'server' 且 island: true
      const mode = island ? 'server' : (fileName.match(COMPONENT_MODE_RE)?.[1] || 'all') as 'client' | 'server' | 'all'
      fileName = fileName.replace(MODE_REPLACEMENT_RE, '')

      if (fileName.toLowerCase() === 'index') {
        fileName = dir.pathPrefix === false ? basename(dirname(filePath)) : '' /* inherits from path */
      }

      const suffix = (mode !== 'all' ? `-${mode}` : '')
      const componentNameSegments = resolveComponentNameSegments(fileName.replace(QUOTE_RE, ''), prefixParts)
      const pascalName = pascalCase(componentNameSegments)

      // if (/^Lazy[A-Z]/.test(pascalName)) {
      //   logger.warn(...) // 提醒不要自己命名 LazyXxx
      // }
      if (LAZY_COMPONENT_NAME_REGEX.test(pascalName)) {
        logger.warn(`The component \`${pascalName}\` (in \`${filePath}\`) is using the reserved "Lazy" prefix used for dynamic imports, which may cause it to break at runtime.`)
      }

      // 如果多个组件文件解析成相同的 PascalCase 名，会打印警告并避免冲突。
      if (resolvedNames.has(pascalName + suffix) || resolvedNames.has(pascalName)) {
        warnAboutDuplicateComponent(pascalName, filePath, resolvedNames.get(pascalName) || resolvedNames.get(pascalName + suffix)!)
        continue
      }
      resolvedNames.set(pascalName + suffix, filePath)

      // 生成组件注册名 & chunk 名（用于自动导入和 chunk 映射）。
      const kebabName = kebabCase(componentNameSegments)
      const shortPath = relative(srcDir, filePath)
      const chunkName = 'components/' + kebabName + suffix

      let component: Component = {
        // inheritable from directory configuration
        mode,
        global,
        island,
        prefetch: Boolean(dir.prefetch),
        preload: Boolean(dir.preload),
        // specific to the file
        filePath,
        pascalName,
        kebabName,
        chunkName,
        shortPath,
        export: 'default',
        // by default, give priority to scanned components
        priority: dir.priority ?? 1,
        // @ts-expect-error untyped property
        _scanned: true,
      }

      // 支持用户通过 extendComponent 钩子扩展组件定义。
      if (typeof dir.extendComponent === 'function') {
        component = (await dir.extendComponent(component)) || component
      }

      // Ignore files like `~/components/index.vue` which end up not having a name at all
      if (!pascalName) {
        logger.warn(`Component did not resolve to a file name in \`~/${relative(srcDir, filePath)}\`.`)
        continue
      }

      const existingComponent = components.find(c => c.pascalName === component.pascalName && ['all', component.mode].includes(c.mode))
      // Ignore component if component is already defined (with same mode)
      if (existingComponent) {
        const existingPriority = existingComponent.priority ?? 0
        const newPriority = component.priority ?? 0

        // Replace component if priority is higher
        // 比如组件来自 layer A vs layer B，设置不同 priority 可控制覆盖顺序。
        if (newPriority > existingPriority) {
          components.splice(components.indexOf(existingComponent), 1, component)
        }
        // Warn if a user-defined (or prioritized) component conflicts with a previously scanned component
        if (newPriority > 0 && newPriority === existingPriority) {
          warnAboutDuplicateComponent(pascalName, filePath, existingComponent.filePath)
        }

        continue
      }

      components.push(component)
    }
    scannedPaths.push(dir.path)
  }

  // （每个返回的 Component 对象）
  //
  // 字段名	含义
  // filePath	组件文件路径
  // pascalName	PascalCase 组件名
  // kebabName	kebab-case 组件名
  // mode	加载模式：client / server / all
  // island	是否 island
  // global	是否 global 注册
  // chunkName	webpack chunk 名
  // shortPath	相对路径
  // _scanned	是否来自自动扫描
  return components
}

function warnAboutDuplicateComponent (componentName: string, filePath: string, duplicatePath: string) {
  logger.warn(`Two component files resolving to the same name \`${componentName}\`:\n` +
    `\n - ${filePath}` +
    `\n - ${duplicatePath}`,
  )
}

const LAZY_COMPONENT_NAME_REGEX = /^Lazy(?=[A-Z])/
