import { existsSync, promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { basename, isAbsolute, join, normalize, parse, relative, resolve } from 'pathe'
import { hash } from 'ohash'
import type { Nuxt, NuxtServerTemplate, NuxtTemplate, NuxtTypeTemplate, ResolvedNuxtTemplate, TSReference } from '@nuxt/schema'
import { withTrailingSlash } from 'ufo'
import { defu } from 'defu'
import type { TSConfig } from 'pkg-types'
import { gte } from 'semver'
import { readPackageJSON } from 'pkg-types'
import { resolveModulePath } from 'exsolve'
import { captureStackTrace } from 'errx'

import { distDirURL, filterInPlace } from './utils'
import { directoryToURL } from './internal/esm'
import { getDirectory } from './module/install'
import { tryUseNuxt, useNuxt } from './context'
import { resolveNuxtModule } from './resolve'

// 负责 在构建期间生成模板文件（包括 .ts 类型声明文件）到 .nuxt 目录或虚拟文件系统，
// 并且 自动维护和生成最终的 tsconfig.json 和 nuxt.d.ts 文件。

/**
 * Renders given template during build into the virtual file system (and optionally to disk in the project `buildDir`)
 */
export function addTemplate<T> (_template: NuxtTemplate<T> | string) {
  const nuxt = useNuxt()

  // Normalize template
  const template = normalizeTemplate(_template)

  // Remove any existing template with the same destination path
  filterInPlace(nuxt.options.build.templates, p => normalizeTemplate(p).dst !== template.dst)

  try {
    const distDir = distDirURL.toString()
    const { source } = captureStackTrace().find(e => e.source && !e.source.startsWith(distDir)) ?? {}
    if (source) {
      const path = normalize(fileURLToPath(source))
      if (existsSync(path)) {
        template._path = path
      }
    }
  } catch {
    // ignore errors as this is an additive feature
  }

  // Add to templates array
  nuxt.options.build.templates.push(template)

  return template
}

/**
 * Adds a virtual file that can be used within the Nuxt Nitro server build.
 */
export function addServerTemplate (template: NuxtServerTemplate) {
  const nuxt = useNuxt()

  nuxt.options.nitro.virtual ||= {}
  nuxt.options.nitro.virtual[template.filename] = template.getContents

  return template
}

/**
 * Renders given types during build to disk in the project `buildDir`
 * and register them as types.
 *
 * You can pass a second context object to specify in which context the type should be added.
 *
 * If no context object is passed, then it will only be added to the nuxt context.
 */
export function addTypeTemplate<T> (_template: NuxtTypeTemplate<T>, context?: { nitro?: boolean, nuxt?: boolean }) {
  const nuxt = useNuxt()

  const template = addTemplate(_template)

  if (!template.filename.endsWith('.d.ts')) {
    throw new Error(`Invalid type template. Filename must end with .d.ts : "${template.filename}"`)
  }

  // Add template to types reference
  if (!context || context.nuxt) {
    nuxt.hook('prepare:types', ({ references }) => {
      references.push({ path: template.dst })
    })
  }
  if (context?.nitro) {
    nuxt.hook('nitro:prepare:types', ({ references }) => {
      references.push({ path: template.dst })
    })
  }

  return template
}

/**
 * Normalize a nuxt template object
 * NormalizeTemplate 是 Nuxt 模板系统中用于标准化模板配置的核心工具函数，主要作用是对传入的模板配置进行规范化处理
 */
export function normalizeTemplate<T> (template: NuxtTemplate<T> | string, buildDir?: string): ResolvedNuxtTemplate<T> {
  if (!template) {
    throw new Error('Invalid template: ' + JSON.stringify(template))
  }

  // Normalize
  // 将字符串或部分配置转换为标准模板对象格式
  if (typeof template === 'string') {
    template = { src: template }
  } else {
    template = { ...template }
  }

  // Use src if provided
  if (template.src) {
    if (!existsSync(template.src)) {
      throw new Error('Template not found: ' + template.src)
    }

    // 自动生成 filename
    if (!template.filename) {
      const srcPath = parse(template.src)
      template.filename = (template as any).fileName || `${basename(srcPath.dir)}.${srcPath.name}.${hash(template.src)}${srcPath.ext}`
    }
  }

  if (!template.src && !template.getContents) {
    throw new Error('Invalid template. Either `getContents` or `src` should be provided: ' + JSON.stringify(template))
  }

  if (!template.filename) {
    throw new Error('Invalid template. `filename` must be provided: ' + JSON.stringify(template))
  }

  // Always write declaration files
  // 自动标记需要写入磁盘
  if (template.filename.endsWith('.d.ts')) {
    template.write = true
  }

  // Resolve dst
  // 解析 dst
  template.dst ||= resolve(buildDir ?? useNuxt().options.buildDir, template.filename)

  return template as ResolvedNuxtTemplate<T>
}

/**
 * Trigger rebuilding Nuxt templates
 *
 * You can pass a filter within the options to selectively regenerate a subset of templates.
 */
export async function updateTemplates (options?: { filter?: (template: ResolvedNuxtTemplate<any>) => boolean }) {
  return await tryUseNuxt()?.hooks.callHook('builder:generateApp', options)
}

const EXTENSION_RE = /\b(?:\.d\.[cm]?ts|\.\w+)$/g
// Exclude bridge alias types to support Volar
const excludedAlias = [/^@vue\/.*$/, /^#internal\/nuxt/]

// 负责自动生成 tsconfig.json 和 nuxt.d.ts 文件，主要流程是：
//
// 收集所有应该包含的源文件（include）
//
// 排除不应该扫描的文件夹（exclude）
//
// 自动根据模块/别名生成 tsconfig 中的 paths 配置
//
// 自动生成 .d.ts 声明引用（/// <reference />）
//
// 最后统一输出对象 { tsConfig, declaration }
//
// 细节亮点：
//
// 兼容 Nuxt2 / Nuxt3
//
// 支持未来 .decorators 特性
//
// 支持最新 TypeScript 的 "module": "preserve" 配置
//
// 根据 Nuxt Layer、Module 动态补充 include/exclude
//
// 避免包含 node_modules 里的模块
//
// 处理 #build、虚拟路径等特殊情况

export async function _generateTypes (nuxt: Nuxt) {
  const rootDirWithSlash = withTrailingSlash(nuxt.options.rootDir)
  const relativeRootDir = relativeWithDot(nuxt.options.buildDir, nuxt.options.rootDir)

  const include = new Set<string>([
    './nuxt.d.ts',
    join(relativeRootDir, '.config/nuxt.*'),
    join(relativeRootDir, '**/*'),
  ])

  if (nuxt.options.srcDir !== nuxt.options.rootDir) {
    include.add(join(relative(nuxt.options.buildDir, nuxt.options.srcDir), '**/*'))
  }

  if (nuxt.options.typescript.includeWorkspace && nuxt.options.workspaceDir !== nuxt.options.rootDir) {
    include.add(join(relative(nuxt.options.buildDir, nuxt.options.workspaceDir), '**/*'))
  }

  for (const layer of nuxt.options._layers) {
    const srcOrCwd = layer.config.srcDir ?? layer.cwd
    if (!srcOrCwd.startsWith(rootDirWithSlash) || srcOrCwd.includes('node_modules')) {
      include.add(join(relative(nuxt.options.buildDir, srcOrCwd), '**/*'))
    }
  }

  const exclude = new Set<string>([
    // nitro generate output: https://github.com/nuxt/nuxt/blob/main/packages/nuxt/src/core/nitro.ts#L186
    relativeWithDot(nuxt.options.buildDir, resolve(nuxt.options.rootDir, 'dist')),
  ])

  for (const dir of nuxt.options.modulesDir) {
    exclude.add(relativeWithDot(nuxt.options.buildDir, dir))
  }

  const moduleEntryPaths: string[] = []
  for (const m of nuxt.options._installedModules) {
    if (m.entryPath) {
      moduleEntryPaths.push(getDirectory(m.entryPath))
    }
  }

  const modulePaths = await resolveNuxtModule(rootDirWithSlash, moduleEntryPaths)

  for (const path of modulePaths) {
    const relative = relativeWithDot(nuxt.options.buildDir, path)
    include.add(join(relative, 'runtime'))
    exclude.add(join(relative, 'runtime/server'))
    include.add(join(relative, 'dist/runtime'))
    exclude.add(join(relative, 'dist/runtime/server'))
  }

  const isV4 = nuxt.options.future?.compatibilityVersion === 4
  const nestedModulesDirs: string[] = []
  for (const dir of [...nuxt.options.modulesDir].sort()) {
    const withSlash = withTrailingSlash(dir)
    if (nestedModulesDirs.every(d => !d.startsWith(withSlash))) {
      nestedModulesDirs.push(withSlash)
    }
  }

  let hasTypescriptVersionWithModulePreserve
  for (const parent of nestedModulesDirs) {
    hasTypescriptVersionWithModulePreserve ??= await readPackageJSON('typescript', { parent })
      .then(r => r?.version && gte(r.version, '5.4.0'))
      .catch(() => undefined)
  }
  hasTypescriptVersionWithModulePreserve ??= isV4

  const useDecorators = Boolean(nuxt.options.experimental?.decorators)

  // https://www.totaltypescript.com/tsconfig-cheat-sheet
  const tsConfig: TSConfig = defu(nuxt.options.typescript?.tsConfig, {
    compilerOptions: {
      /* Base options: */
      esModuleInterop: true,
      skipLibCheck: true,
      target: 'ESNext',
      allowJs: true,
      resolveJsonModule: true,
      moduleDetection: 'force',
      isolatedModules: true,
      verbatimModuleSyntax: true,
      /* Strictness */
      strict: nuxt.options.typescript?.strict ?? true,
      noUncheckedIndexedAccess: isV4,
      forceConsistentCasingInFileNames: true,
      noImplicitOverride: true,
      /* Decorator support */
      ...useDecorators
        ? {
            experimentalDecorators: false,
          }
        : {},
      /* If NOT transpiling with TypeScript: */
      module: hasTypescriptVersionWithModulePreserve ? 'preserve' : 'ESNext',
      noEmit: true,
      /* If your code runs in the DOM: */
      lib: [
        'ESNext',
        ...useDecorators ? ['esnext.decorators'] : [],
        'dom',
        'dom.iterable',
        'webworker',
      ],
      /* JSX support for Vue */
      jsx: 'preserve',
      jsxImportSource: 'vue',
      /* remove auto-scanning for types */
      types: [],
      /* add paths object for filling-in later */
      paths: {},
      /* Possibly consider removing the following in future */
      moduleResolution: nuxt.options.future?.typescriptBundlerResolution || (nuxt.options.experimental as any)?.typescriptBundlerResolution ? 'Bundler' : 'Node', /* implied by module: preserve */
      useDefineForClassFields: true, /* implied by target: es2022+ */
      noImplicitThis: true, /* enabled with `strict` */
      allowSyntheticDefaultImports: true,
    },
    include: [...include],
    exclude: [...exclude],
  } satisfies TSConfig)

  const aliases: Record<string, string> = nuxt.options.alias

  const basePath = tsConfig.compilerOptions!.baseUrl
    ? resolve(nuxt.options.buildDir, tsConfig.compilerOptions!.baseUrl)
    : nuxt.options.buildDir

  tsConfig.compilerOptions ||= {}
  tsConfig.compilerOptions.paths ||= {}
  tsConfig.include ||= []

  const importPaths = nuxt.options.modulesDir.map(d => directoryToURL(d))

  for (const alias in aliases) {
    if (excludedAlias.some(re => re.test(alias))) {
      continue
    }
    let absolutePath = resolve(basePath, aliases[alias]!)
    let stats = await fsp.stat(absolutePath).catch(() => null /* file does not exist */)
    if (!stats) {
      const resolvedModule = resolveModulePath(aliases[alias]!, {
        try: true,
        from: importPaths,
        extensions: [...nuxt.options.extensions, '.d.ts', '.d.mts', '.d.cts'],
      })
      if (resolvedModule) {
        absolutePath = resolvedModule
        stats = await fsp.stat(resolvedModule).catch(() => null)
      }
    }

    const relativePath = relativeWithDot(nuxt.options.buildDir, absolutePath)
    if (stats?.isDirectory()) {
      tsConfig.compilerOptions.paths[alias] = [relativePath]
      tsConfig.compilerOptions.paths[`${alias}/*`] = [`${relativePath}/*`]

      if (!absolutePath.startsWith(rootDirWithSlash)) {
        tsConfig.include.push(relativePath)
      }
    } else {
      const path = stats?.isFile()
        // remove extension
        ? relativePath.replace(EXTENSION_RE, '')
        // non-existent file probably shouldn't be resolved
        : aliases[alias]!

      tsConfig.compilerOptions.paths[alias] = [path]

      if (!absolutePath.startsWith(rootDirWithSlash)) {
        tsConfig.include.push(path)
      }
    }
  }

  const references: TSReference[] = []
  await Promise.all([...nuxt.options.modules, ...nuxt.options._modules].map(async (id) => {
    if (typeof id !== 'string') { return }

    for (const parent of nestedModulesDirs) {
      const pkg = await readPackageJSON(id, { parent }).catch(() => null)
      if (pkg) {
        references.push(({ types: pkg.name ?? id }))
        return
      }
    }

    references.push(({ types: id }))
  }))

  const declarations: string[] = []

  await nuxt.callHook('prepare:types', { references, declarations, tsConfig })

  for (const alias in tsConfig.compilerOptions!.paths) {
    const paths = tsConfig.compilerOptions!.paths[alias]
    tsConfig.compilerOptions!.paths[alias] = await Promise.all(paths.map(async (path: string) => {
      if (!isAbsolute(path)) { return path }
      const stats = await fsp.stat(path).catch(() => null /* file does not exist */)
      return relativeWithDot(nuxt.options.buildDir, stats?.isFile() ? path.replace(EXTENSION_RE, '') /* remove extension */ : path)
    }))
  }

  // Ensure `#build` is placed at the end of the paths object.
  // https://github.com/nuxt/nuxt/issues/30325
  sortTsPaths(tsConfig.compilerOptions.paths)

  tsConfig.include = [...new Set(tsConfig.include.map(p => isAbsolute(p) ? relativeWithDot(nuxt.options.buildDir, p) : p))]
  tsConfig.exclude = [...new Set(tsConfig.exclude!.map(p => isAbsolute(p) ? relativeWithDot(nuxt.options.buildDir, p) : p))]

  const declaration = [
    ...references.map((ref) => {
      if ('path' in ref && isAbsolute(ref.path)) {
        ref.path = relative(nuxt.options.buildDir, ref.path)
      }
      return `/// <reference ${renderAttrs(ref)} />`
    }),
    ...declarations,
    '',
    'export {}',
    '',
  ].join('\n')

  return {
    declaration,
    tsConfig,
  }
}

export async function writeTypes (nuxt: Nuxt) {
  const { tsConfig, declaration } = await _generateTypes(nuxt)

  async function writeFile () {
    const GeneratedBy = '// Generated by nuxi'

    const tsConfigPath = resolve(nuxt.options.buildDir, 'tsconfig.json')
    await fsp.mkdir(nuxt.options.buildDir, { recursive: true })
    await fsp.writeFile(tsConfigPath, GeneratedBy + '\n' + JSON.stringify(tsConfig, null, 2))

    const declarationPath = resolve(nuxt.options.buildDir, 'nuxt.d.ts')
    await fsp.writeFile(declarationPath, GeneratedBy + '\n' + declaration)
  }

  // This is needed for Nuxt 2 which clears the build directory again before building
  // https://github.com/nuxt/nuxt/blob/2.x/packages/builder/src/builder.js#L144
  // @ts-expect-error TODO: Nuxt 2 hook
  nuxt.hook('builder:prepared', writeFile)

  await writeFile()
}

function sortTsPaths (paths: Record<string, string[]>) {
  for (const pathKey in paths) {
    if (pathKey.startsWith('#build')) {
      const pathValue = paths[pathKey]!
      // Delete & Reassign to ensure key is inserted at the end of object.
      delete paths[pathKey]
      paths[pathKey] = pathValue
    }
  }
}

function renderAttrs (obj: Record<string, string>) {
  const attrs: string[] = []
  for (const key in obj) {
    attrs.push(renderAttr(key, obj[key]))
  }
  return attrs.join(' ')
}

function renderAttr (key: string, value?: string) {
  return value ? `${key}="${value}"` : ''
}

const RELATIVE_WITH_DOT_RE = /^([^.])/
function relativeWithDot (from: string, to: string) {
  return relative(from, to).replace(RELATIVE_WITH_DOT_RE, './$1') || '.'
}
