import { runInNewContext } from 'node:vm'
import fs from 'node:fs'
import { extname, normalize, relative, resolve } from 'pathe'
import { encodePath, joinURL, withLeadingSlash } from 'ufo'
import { resolveFiles, resolvePath, useNuxt } from '@nuxt/kit'
import { genArrayFromRaw, genDynamicImport, genImport, genSafeVariableName } from 'knitwork'
import escapeRE from 'escape-string-regexp'
import { filename } from 'pathe/utils'
import { hash } from 'ohash'
import type { Property } from 'estree'
import type { NuxtPage } from 'nuxt/schema'

import { klona } from 'klona'
import { parseAndWalk, withLocations } from '../core/utils/parse'
import { getLoader, uniqueBy } from '../core/utils'
import { logger, toArray } from '../utils'

enum SegmentParserState {
  initial,
  static,
  dynamic,
  optional,
  catchall,
  group,
}

enum SegmentTokenType {
  static,
  dynamic,
  optional,
  catchall,
  group,
}

interface SegmentToken {
  type: SegmentTokenType
  value: string
}

interface ScannedFile {
  relativePath: string
  absolutePath: string
}

// 通过文件生成路由信息
// 功能 ---	说明
// 扫描 pages 目录	---	递归遍历所有 .vue 页面文件
// 解析文件路径为路由路径	---	将 pages/index.vue 转换为 /，pages/blog/[slug].vue 转换为 /blog/:slug
// 构建页面树结构	---	支持嵌套路由（children）、布局、meta 信息、name 等
// 支持动态参数、可选参数、别名、命名路由等 Nuxt 特性 ---
// 用于生成 app.pages、routes.mjs、typed-router 类型文件等 ---
export async function resolvePagesRoutes (pattern: string | string[], nuxt = useNuxt()): Promise<NuxtPage[]> {
  // 示例 1：基础页面结构
  // 目录结构：
  // pages/
  //   index.vue
  //   about.vue
  //   blog/
  //     index.vue
  //     [slug].vue
  // 执行：resolvePagesRoutes() → 返回结构：
  // [
  //   { path: '/', file: 'pages/index.vue' },
  //   { path: '/about', file: 'pages/about.vue' },
  //   {
  //     path: '/blog',
  //     file: 'pages/blog/index.vue',
  //     children: [
  //       { path: ':slug', file: 'pages/blog/[slug].vue' }
  //     ]
  //   }
  // ]

  // 示例 2：动态参数 + 可选参数 + catch-all
  // 目录结构：
  // pages/
  //   user/
  //     [id].vue
  //     [id]/
  //       settings.vue
  //     [id].settings.vue
  //     [...slug].vue
  // 返回结构：
  // [
  //   { path: '/user/:id', file: 'pages/user/[id].vue' },
  //   {
  //     path: '/user/:id',
  //     children: [
  //       { path: 'settings', file: 'pages/user/[id]/settings.vue' }
  //     ]
  //   },
  //   { path: '/user/:id.settings', file: 'pages/user/[id].settings.vue' },
  //   { path: '/user/:slug(.*)', file: 'pages/user/[...slug].vue' }
  // ]
  // :slug(.*) 是 Vue Router 对 ** 或 ...slug 的解析方式（匹配任意路径）。

  // 示例 3：命名页面、定义别名、设置 meta
  // 如果你在页面中使用：
  // <!-- pages/about.vue -->
  // <script setup lang="ts">
  // definePageMeta({
  //   alias: ['/info'],
  //   name: 'aboutPage',
  //   layout: 'custom'
  // })
  // </script>
  // resolvePagesRoutes() 结果包含：
  // {
  //   path: '/about',
  //   file: 'pages/about.vue',
  //   alias: ['/info'],
  //   name: 'aboutPage',
  //   meta: { layout: 'custom' }
  // }
  const pagesDirs = nuxt.options._layers.map(
    layer => resolve(layer.config.srcDir, (layer.config.rootDir === nuxt.options.rootDir ? nuxt.options : layer.config).dir?.pages || 'pages'),
  )

  const scannedFiles: ScannedFile[] = []
  for (const dir of pagesDirs) {
    const files = await resolveFiles(dir, pattern)
    scannedFiles.push(...files.map(file => ({ relativePath: relative(dir, file), absolutePath: file })))
  }

  // sort scanned files using en-US locale to make the result consistent across different system locales
  scannedFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'en-US'))

  const allRoutes = generateRoutesFromFiles(uniqueBy(scannedFiles, 'relativePath'), {
    shouldUseServerComponents: !!nuxt.options.experimental.componentIslands,
  })

  const pages = uniqueBy(allRoutes, 'path')
  const shouldAugment = nuxt.options.experimental.scanPageMeta || nuxt.options.experimental.typedPages

  if (shouldAugment === false) {
    await nuxt.callHook('pages:extend', pages)
    return pages
  }

  const augmentCtx = {
    extraExtractionKeys: nuxt.options.experimental.extraPageMetaExtractionKeys,
    fullyResolvedPaths: new Set(scannedFiles.map(file => file.absolutePath)),
  }
  if (shouldAugment === 'after-resolve') {
    await nuxt.callHook('pages:extend', pages)
    // 1
    await augmentPages(pages, nuxt.vfs, augmentCtx)
  } else {
    const augmentedPages = await augmentPages(pages, nuxt.vfs, augmentCtx)
    await nuxt.callHook('pages:extend', pages)
    await augmentPages(pages, nuxt.vfs, { pagesToSkip: augmentedPages, ...augmentCtx })
    augmentedPages?.clear()
  }

  await nuxt.callHook('pages:resolved', pages)

  return pages
}

type GenerateRoutesFromFilesOptions = {
  shouldUseServerComponents?: boolean
}

const INDEX_PAGE_RE = /\/index$/
// 输入：页面文件路径数组（通常由 glob 扫描得出）；
// 输出：RouteRecordRaw[] 类型的路由配置数组（符合 Vue Router 的结构）；
// 自动支持嵌套路由、动态参数（[id].vue）、可选参数（[id]?）、catch-all 路由（[...all].vue）等。

// 路由生成规则概览
// 文件名	路由 path	说明
// index.vue	/	根路径
// about.vue	/about	普通静态路径
// [slug].vue	/:slug	动态参数
// [id]?/profile.vue	/:id?/profile	可选参数
// [...all].vue	/:all(.*)*	catch-all 匹配
// blog/index.vue	/blog	嵌套目录
// blog/[slug]/comments.vue	/blog/:slug/comments	多级动态嵌套
export function generateRoutesFromFiles (files: ScannedFile[], options: GenerateRoutesFromFilesOptions = {}): NuxtPage[] {
  const routes: NuxtPage[] = []

  const sortedFiles = [...files].sort((a, b) => a.relativePath.length - b.relativePath.length)

  for (const file of sortedFiles) {
    const segments = file.relativePath
      .replace(new RegExp(`${escapeRE(extname(file.relativePath))}$`), '')
      .split('/')

    const route: NuxtPage = {
      name: '',
      path: '',
      file: file.absolutePath,
      children: [],
    }

    // Array where routes should be added, useful when adding child routes
    let parent = routes

    const lastSegment = segments[segments.length - 1]!
    if (lastSegment.endsWith('.server')) {
      segments[segments.length - 1] = lastSegment.replace('.server', '')
      if (options.shouldUseServerComponents) {
        route.mode = 'server'
      }
    } else if (lastSegment.endsWith('.client')) {
      segments[segments.length - 1] = lastSegment.replace('.client', '')
      route.mode = 'client'
    }

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]

      const tokens = parseSegment(segment!, file.absolutePath)

      // Skip group segments
      if (tokens.every(token => token.type === SegmentTokenType.group)) {
        continue
      }

      const segmentName = tokens.map(({ value, type }) => type === SegmentTokenType.group ? '' : value).join('')

      // ex: parent/[slug].vue -> parent-slug
      route.name += (route.name && '/') + segmentName

      // ex: parent.vue + parent/child.vue
      const routePath = getRoutePath(tokens, segments[i + 1] !== undefined)
      const path = withLeadingSlash(joinURL(route.path, routePath.replace(INDEX_PAGE_RE, '/')))
      const child = parent.find(parentRoute => parentRoute.name === route.name && parentRoute.path === path)

      if (child && child.children) {
        parent = child.children
        route.path = ''
      } else if (segmentName === 'index' && !route.path) {
        route.path += '/'
      } else if (segmentName !== 'index') {
        route.path += routePath
      }
    }

    parent.push(route)
  }

  return prepareRoutes(routes)
}

interface AugmentPagesContext {
  fullyResolvedPaths?: Set<string>
  pagesToSkip?: Set<string>
  augmentedPages?: Set<string>
  extraExtractionKeys?: string[]
}

// 中用于 增强页面路由信息（meta 数据） 的关键工具函数，广泛应用于：
// 自动提取 definePageMeta() 或 defineRouteRules() 的内容；
// 注入到每个页面的 route.meta 字段；
// 用于构建 typed router、路由规则合并、预渲染规则、页面 transition、layout、middleware 等功能。
// routes: 页面结构树（由 generateRoutesFromFiles() 生成的路由配置）；
// vfs: 虚拟文件系统（测试环境或 vite dev 模式下用，不用读硬盘）；
// ctx: 上下文信息，包括已处理文件、跳过文件等缓存；
// 2
export async function augmentPages (routes: NuxtPage[], vfs: Record<string, string>, ctx: AugmentPagesContext = {}) {
  ctx.augmentedPages ??= new Set()
  for (const route of routes) {
    if (route.file && !ctx.pagesToSkip?.has(route.file)) {
      // 优先从 vfs 虚拟文件系统读取；
      // 否则通过 resolvePath() 加载硬盘上 .vue 文件内容。
      const fileContent = route.file in vfs
        ? vfs[route.file]!
        : fs.readFileSync(ctx.fullyResolvedPaths?.has(route.file) ? route.file : await resolvePath(route.file), 'utf-8')
      // 通过静态分析源码（使用 Babel/AST）提取：
      // definePageMeta({ layout, middleware, keepalive, transition })
      // defineRouteRules({ prerender, headers })
      // 自定义扩展 meta key
      // 返回结构类似：
      // {
      //   meta: {
      //     layout: 'admin',
      //     middleware: ['auth'],
      //     prerender: true
      //   }
      // }
      // 3
      const routeMeta = await getRouteMeta(fileContent, route.file, ctx.extraExtractionKeys)
      // 合并已有 meta（比如配置中已有的）
      if (route.meta) {
        routeMeta.meta = { ...routeMeta.meta, ...route.meta }
      }

      // 直接在路由对象上追加/更新 meta 字段；
      // 记录该页面已经被处理，避免重复提取。
      Object.assign(route, routeMeta)
      ctx.augmentedPages.add(route.file)
    }

    // 递归子页面
    if (route.children && route.children.length > 0) {
      await augmentPages(route.children, vfs, ctx)
    }
  }
  // 返回一个 Set<string>，表示哪些页面文件已被增强处理过。
  return ctx.augmentedPages
}

// 用于匹配 .vue 文件中所有 <script> 标签的正则，含两个命名捕获组：
const SFC_SCRIPT_RE = /<script(?<attrs>[^>]*)>(?<content>[\s\S]*?)<\/script[^>]*>/gi
// 参数 sfc：.vue 文件的完整内容（字符串）
// 返回值：一个数组，数组中的每一项是提取出的 <script> 代码段，包括其 loader 类型（用于后续 AST 解析或转译）。
export function extractScriptContent (sfc: string) {
  const contents: Array<{ loader: 'tsx' | 'ts', code: string }> = []
  for (const match of sfc.matchAll(SFC_SCRIPT_RE)) {
    if (match?.groups?.content) {
      contents.push({
        loader: match.groups.attrs && /[tj]sx/.test(match.groups.attrs) ? 'tsx' : 'ts',
        code: match.groups.content.trim(),
      })
    }
  }

  return contents
}

const PAGE_META_RE = /definePageMeta\([\s\S]*?\)/
const defaultExtractionKeys = ['name', 'path', 'props', 'alias', 'redirect'] as const
const DYNAMIC_META_KEY = '__nuxt_dynamic_meta_key' as const

const pageContentsCache: Record<string, string> = {}
const metaCache: Record<string, Partial<Record<keyof NuxtPage, any>>> = {}
// 负责从 .vue 页面文件中提取 definePageMeta() 宏中定义的静态内容（如 name、path、alias、middleware 等），并将这些信息注入到 NuxtPage 的 meta 字段中。
export function getRouteMeta (contents: string, absolutePath: string, extraExtractionKeys: string[] = []): Partial<Record<keyof NuxtPage, any>> {
  // set/update pageContentsCache, invalidate metaCache on cache mismatch
  // 如果源码变更，清空之前的缓存，避免重复提取或过时数据。
  if (!(absolutePath in pageContentsCache) || pageContentsCache[absolutePath] !== contents) {
    pageContentsCache[absolutePath] = contents
    delete metaCache[absolutePath]
  }

  if (absolutePath in metaCache && metaCache[absolutePath]) {
    return klona(metaCache[absolutePath])
  }

  const loader = getLoader(absolutePath)
  // 如果是 .vue 文件，则提取 <script> 块；
  // 否则直接拿整段代码（如 .ts 文件）；
  // 这是为了后续用 AST 解析 definePageMeta(...) 调用。
  const scriptBlocks = !loader ? null : loader === 'vue' ? extractScriptContent(contents) : [{ code: contents, loader }]
  if (!scriptBlocks) {
    metaCache[absolutePath] = {}
    return {}
  }

  const extractedMeta: Partial<Record<keyof NuxtPage, any>> = {}

  // 默认提取字段包括：
  // name
  // path
  // props
  // alias
  // redirect
  const extractionKeys = new Set<keyof NuxtPage>([...defaultExtractionKeys, ...extraExtractionKeys as Array<keyof NuxtPage>])

  for (const script of scriptBlocks) {
    if (!PAGE_META_RE.test(script.code)) {
      continue
    }

    const dynamicProperties = new Set<keyof NuxtPage>()

    let foundMeta = false

    parseAndWalk(script.code, absolutePath.replace(/\.\w+$/, '.' + script.loader), (node) => {
      if (foundMeta) { return }

      // 找到宏函数；
      // 要求参数是 ObjectExpression（字面对象）；
      // 否则提示开发者函数调用不合法。
      if (node.type !== 'ExpressionStatement' || node.expression.type !== 'CallExpression' || node.expression.callee.type !== 'Identifier' || node.expression.callee.name !== 'definePageMeta') { return }

      foundMeta = true
      const pageMetaArgument = node.expression.arguments[0]
      if (pageMetaArgument?.type !== 'ObjectExpression') {
        logger.warn(`\`definePageMeta\` must be called with an object literal (reading \`${absolutePath}\`).`)
        return
      }

      for (const key of extractionKeys) {
        const property = pageMetaArgument.properties.find((property): property is Property => property.type === 'Property' && property.key.type === 'Identifier' && property.key.name === key)
        if (!property) { continue }

        const propertyValue = withLocations(property.value)

        if (propertyValue.type === 'ObjectExpression') {
          const valueString = script.code.slice(propertyValue.start, propertyValue.end)
          try {
            extractedMeta[key] = JSON.parse(runInNewContext(`JSON.stringify(${valueString})`, {}))
          } catch {
            logger.debug(`Skipping extraction of \`${key}\` metadata as it is not JSON-serializable (reading \`${absolutePath}\`).`)
            dynamicProperties.add(key)
            continue
          }
        }

        if (propertyValue.type === 'ArrayExpression') {
          const values: string[] = []
          for (const element of propertyValue.elements) {
            if (!element) {
              continue
            }
            if (element.type !== 'Literal' || typeof element.value !== 'string') {
              logger.debug(`Skipping extraction of \`${key}\` metadata as it is not an array of string literals (reading \`${absolutePath}\`).`)
              dynamicProperties.add(key)
              continue
            }
            values.push(element.value)
          }
          extractedMeta[key] = values
          continue
        }

        if (propertyValue.type !== 'Literal' || (typeof propertyValue.value !== 'string' && typeof propertyValue.value !== 'boolean')) {
          logger.debug(`Skipping extraction of \`${key}\` metadata as it is not a string literal or array of string literals (reading \`${absolutePath}\`).`)
          dynamicProperties.add(key)
          continue
        }
        extractedMeta[key] = propertyValue.value
      }

      for (const property of pageMetaArgument.properties) {
        if (property.type !== 'Property') {
          continue
        }
        const isIdentifierOrLiteral = property.key.type === 'Literal' || property.key.type === 'Identifier'
        if (!isIdentifierOrLiteral) {
          continue
        }
        const name = property.key.type === 'Identifier' ? property.key.name : String(property.value)
        if (!extraExtractionKeys.includes(name as keyof NuxtPage)) {
          dynamicProperties.add('meta')
          break
        }
      }

      if (dynamicProperties.size) {
        extractedMeta.meta ??= {}
        extractedMeta.meta[DYNAMIC_META_KEY] = dynamicProperties
      }
    })
  }

  metaCache[absolutePath] = extractedMeta
  return klona(extractedMeta)
}

const COLON_RE = /:/g
function getRoutePath (tokens: SegmentToken[], hasSucceedingSegment = false): string {
  return tokens.reduce((path, token) => {
    return (
      path +
      (token.type === SegmentTokenType.optional
        ? `:${token.value}?`
        : token.type === SegmentTokenType.dynamic
          ? `:${token.value}()`
          : token.type === SegmentTokenType.catchall
            ? hasSucceedingSegment ? `:${token.value}([^/]*)*` : `:${token.value}(.*)*`
            : token.type === SegmentTokenType.group
              ? ''
              : encodePath(token.value).replace(COLON_RE, '\\:'))
    )
  }, '/')
}

const PARAM_CHAR_RE = /[\w.]/

function parseSegment (segment: string, absolutePath: string) {
  let state: SegmentParserState = SegmentParserState.initial
  let i = 0

  let buffer = ''
  const tokens: SegmentToken[] = []

  function consumeBuffer () {
    if (!buffer) {
      return
    }
    if (state === SegmentParserState.initial) {
      throw new Error('wrong state')
    }

    tokens.push({
      type:
        state === SegmentParserState.static
          ? SegmentTokenType.static
          : state === SegmentParserState.dynamic
            ? SegmentTokenType.dynamic
            : state === SegmentParserState.optional
              ? SegmentTokenType.optional
              : state === SegmentParserState.catchall
                ? SegmentTokenType.catchall
                : SegmentTokenType.group,
      value: buffer,
    })

    buffer = ''
  }

  while (i < segment.length) {
    const c = segment[i]

    switch (state) {
      case SegmentParserState.initial:
        buffer = ''
        if (c === '[') {
          state = SegmentParserState.dynamic
        } else if (c === '(') {
          state = SegmentParserState.group
        } else {
          i--
          state = SegmentParserState.static
        }
        break

      case SegmentParserState.static:
        if (c === '[') {
          consumeBuffer()
          state = SegmentParserState.dynamic
        } else if (c === '(') {
          consumeBuffer()
          state = SegmentParserState.group
        } else {
          buffer += c
        }
        break

      case SegmentParserState.catchall:
      case SegmentParserState.dynamic:
      case SegmentParserState.optional:
      case SegmentParserState.group:
        if (buffer === '...') {
          buffer = ''
          state = SegmentParserState.catchall
        }
        if (c === '[' && state === SegmentParserState.dynamic) {
          state = SegmentParserState.optional
        }
        if (c === ']' && (state !== SegmentParserState.optional || segment[i - 1] === ']')) {
          if (!buffer) {
            throw new Error('Empty param')
          } else {
            consumeBuffer()
          }
          state = SegmentParserState.initial
        } else if (c === ')' && state === SegmentParserState.group) {
          if (!buffer) {
            throw new Error('Empty group')
          } else {
            consumeBuffer()
          }
          state = SegmentParserState.initial
        } else if (c && PARAM_CHAR_RE.test(c)) {
          buffer += c
        } else if (state === SegmentParserState.dynamic || state === SegmentParserState.optional) {
          if (c !== '[' && c !== ']') {
            logger.warn(`'\`${c}\`' is not allowed in a dynamic route parameter and has been ignored. Consider renaming \`${absolutePath}\`.`)
          }
        }
        break
    }
    i++
  }

  if (state === SegmentParserState.dynamic) {
    throw new Error(`Unfinished param "${buffer}"`)
  }

  consumeBuffer()

  return tokens
}

function findRouteByName (name: string, routes: NuxtPage[]): NuxtPage | undefined {
  for (const route of routes) {
    if (route.name === name) {
      return route
    }
  }
  return findRouteByName(name, routes)
}

const NESTED_PAGE_RE = /\//g
function prepareRoutes (routes: NuxtPage[], parent?: NuxtPage, names = new Set<string>()) {
  for (const route of routes) {
    // Remove -index
    if (route.name) {
      route.name = route.name
        .replace(INDEX_PAGE_RE, '')
        .replace(NESTED_PAGE_RE, '-')

      if (names.has(route.name)) {
        const existingRoute = findRouteByName(route.name, routes)
        const extra = existingRoute?.name ? `is the same as \`${existingRoute.file}\`` : 'is a duplicate'
        logger.warn(`Route name generated for \`${route.file}\` ${extra}. You may wish to set a custom name using \`definePageMeta\` within the page file.`)
      }
    }

    // Remove leading / if children route
    if (parent && route.path[0] === '/') {
      route.path = route.path.slice(1)
    }

    if (route.children?.length) {
      route.children = prepareRoutes(route.children, route, names)
    }

    if (route.children?.find(childRoute => childRoute.path === '')) {
      delete route.name
    }

    if (route.name) {
      names.add(route.name)
    }
  }

  return routes
}

function serializeRouteValue (value: any, skipSerialisation = false) {
  if (skipSerialisation || value === undefined) { return undefined }
  return JSON.stringify(value)
}

type NormalizedRoute = Partial<Record<Exclude<keyof NuxtPage, 'file'>, string>> & { component?: string }
type NormalizedRouteKeys = (keyof NormalizedRoute)[]
interface NormalizeRoutesOptions {
  overrideMeta?: boolean
  serverComponentRuntime: string
  clientComponentRuntime: string
}
export function normalizeRoutes (routes: NuxtPage[], metaImports: Set<string> = new Set(), options: NormalizeRoutesOptions): { imports: Set<string>, routes: string } {
  return {
    imports: metaImports,
    routes: genArrayFromRaw(routes.map((page) => {
      const markedDynamic = page.meta?.[DYNAMIC_META_KEY] ?? new Set()
      const metaFiltered: Record<string, any> = {}
      let skipMeta = true
      for (const key in page.meta || {}) {
        if (key !== DYNAMIC_META_KEY && page.meta![key] !== undefined) {
          skipMeta = false
          metaFiltered[key] = page.meta![key]
        }
      }
      const skipAlias = toArray(page.alias).every(val => !val)

      const route: NormalizedRoute = {
        path: serializeRouteValue(page.path),
        props: serializeRouteValue(page.props),
        name: serializeRouteValue(page.name),
        meta: serializeRouteValue(metaFiltered, skipMeta),
        alias: serializeRouteValue(toArray(page.alias), skipAlias),
        redirect: serializeRouteValue(page.redirect),
      }

      for (const key of ['path', 'props', 'name', 'meta', 'alias', 'redirect'] satisfies NormalizedRouteKeys) {
        if (route[key] === undefined) {
          delete route[key]
        }
      }

      if (page.children?.length) {
        route.children = normalizeRoutes(page.children, metaImports, options).routes
      }

      // Without a file, we can't use `definePageMeta` to extract route-level meta from the file
      if (!page.file) {
        return route
      }

      const file = normalize(page.file)
      const pageImportName = genSafeVariableName(filename(file) + hash(file))
      const metaImportName = pageImportName + 'Meta'
      metaImports.add(genImport(`${file}?macro=true`, [{ name: 'default', as: metaImportName }]))

      if (page._sync) {
        metaImports.add(genImport(file, [{ name: 'default', as: pageImportName }]))
      }

      const pageImport = page._sync && page.mode !== 'client' ? pageImportName : genDynamicImport(file)

      const metaRoute: NormalizedRoute = {
        name: `${metaImportName}?.name ?? ${route.name}`,
        path: `${metaImportName}?.path ?? ${route.path}`,
        props: `${metaImportName}?.props ?? ${route.props ?? false}`,
        meta: `${metaImportName} || {}`,
        alias: `${metaImportName}?.alias || []`,
        redirect: `${metaImportName}?.redirect`,
        component: page.mode === 'server'
          ? `() => createIslandPage(${route.name})`
          : page.mode === 'client'
            ? `() => createClientPage(${pageImport})`
            : pageImport,
      }

      if (page.mode === 'server') {
        metaImports.add(`
let _createIslandPage
async function createIslandPage (name) {
  _createIslandPage ||= await import(${JSON.stringify(options?.serverComponentRuntime)}).then(r => r.createIslandPage)
  return _createIslandPage(name)
};`)
      } else if (page.mode === 'client') {
        metaImports.add(`
let _createClientPage
async function createClientPage(loader) {
  _createClientPage ||= await import(${JSON.stringify(options?.clientComponentRuntime)}).then(r => r.createClientPage)
  return _createClientPage(loader);
}`)
      }

      if (route.children) {
        metaRoute.children = route.children
      }

      if (route.meta) {
        metaRoute.meta = `{ ...(${metaImportName} || {}), ...${route.meta} }`
      }

      if (options?.overrideMeta) {
        // skip and retain fallback if marked dynamic
        // set to extracted value or fallback if none extracted
        for (const key of ['name', 'path'] satisfies NormalizedRouteKeys) {
          if (markedDynamic.has(key)) { continue }
          metaRoute[key] = route[key] ?? `${metaImportName}?.${key}`
        }

        // set to extracted value or delete if none extracted
        for (const key of ['meta', 'alias', 'redirect', 'props'] satisfies NormalizedRouteKeys) {
          if (markedDynamic.has(key)) { continue }

          if (route[key] == null) {
            delete metaRoute[key]
            continue
          }

          metaRoute[key] = route[key]
        }
      } else {
        if (route.alias != null) {
          metaRoute.alias = `${route.alias}.concat(${metaImportName}?.alias || [])`
        }

        if (route.redirect != null) {
          metaRoute.redirect = route.redirect
        }
      }

      return metaRoute
    })),
  }
}

// 匹配以 / 开头、包含 : 动态参数的路径片段，比如 /blog/:slug。
const PATH_TO_NITRO_GLOB_RE = /\/[^:/]*:\w.*$/


export function pathToNitroGlob (path: string) {
  if (!path) {
    return null
  }
  // Ignore pages with multiple dynamic parameters.
  // // 忽略有多个动态参数的路径（不处理）
  if (path.indexOf(':') !== path.lastIndexOf(':')) {
    return null
  }

  return path.replace(PATH_TO_NITRO_GLOB_RE, '/**')
  // 原始路径	--- 结果
  // /blog/:slug	--- /blog/**
  // /product/:id/review/:comment	--- null （因为有多个动态参数）
  // /about	--- null （无 :）
}

// 递归解析所有页面及子页面的完整路径列表
export function resolveRoutePaths (page: NuxtPage, parent = '/'): string[] {
  // 示例：
  // 假设页面结构为：
  // {
  //   path: 'blog',
  //   children: [
  //     { path: '', file: 'blog/index.vue' },
  //     { path: '[slug]', file: 'blog/[slug].vue' }
  //   ]
  // }
  // 调用：
  // resolveRoutePaths(blogPage)
  // 返回：
  // [
  //   '/blog',
  //   '/blog',
  //   '/blog/:slug'
  // ]
  // （注意：[slug] 页面转成 :slug 是由其他逻辑处理的，这里只拼路径）
  return [
    joinURL(parent, page.path),
    ...page.children?.flatMap(child => resolveRoutePaths(child, joinURL(parent, page.path))) || [],
  ]
}
