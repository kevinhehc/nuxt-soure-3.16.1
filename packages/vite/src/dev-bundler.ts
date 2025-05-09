import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { isAbsolute, normalize, resolve } from 'pathe'
import type * as vite from 'vite'
import type { isExternal } from 'externality'
import { genDynamicImport, genObjectFromRawEntries } from 'knitwork' // 用于生成 import 动态代码及对象构造
import { debounce } from 'perfect-debounce' // 防抖函数，用于监听文件变化时避免频繁构建
import { isIgnored, logger } from '@nuxt/kit'
import { hashId, isCSS, uniq } from './utils' // 工具函数：生成 hash，判断 CSS，数组去重
import { createIsExternal } from './utils/external' // 工具函数：创建外部模块判断函数
import { writeManifest } from './manifest' // 写入 CSS manifest 文件
import type { ViteBuildContext } from './vite'  // 构建上下文类型

interface TransformChunk {
  id: string // 模块 ID（路径）
  code: string // 编译后的代码字符串
  deps: string[] // 静态依赖
  parents: string[]  // 父模块 ID（反向追踪用）
}

interface SSRTransformResult {
  code: string  // 编译结果代码
  map: object  // sourcemap 信息
  deps: string[]  // 静态依赖
  dynamicDeps: string[] // 动态依赖（import()）
}

interface TransformOptions {
  viteServer: vite.ViteDevServer  // Vite 开发服务器实例
  isExternal(id: string): ReturnType<typeof isExternal>  // 判断模块是否为外部依赖
}

// 将某模块转为 SSR 格式的函数体
async function transformRequest (opts: TransformOptions, id: string) {
  // Virtual modules start with `\0`
  // 标准化模块 ID（修复 Vite 虚拟模块路径）
  if (id && id.startsWith('/@id/__x00__')) {
    id = '\0' + id.slice('/@id/__x00__'.length)
  }
  if (id && id.startsWith('/@id/')) {
    id = id.slice('/@id/'.length)
  }

  // 绝对路径模块处理：相对于根目录解析路径
  if (id && !id.startsWith('/@fs/') && id.startsWith('/')) {
    // Relative to the root directory
    const resolvedPath = resolve(opts.viteServer.config.root, '.' + id)
    if (existsSync(resolvedPath)) {
      id = resolvedPath
    }
  }

  // On Windows, we prefix absolute paths with `/@fs/` to skip node resolution algorithm
  // Windows 路径前缀修复
  id = id.replace(/^\/?(?=\w:)/, '/@fs/')

  // Remove query and @fs/ for external modules
  // 检查是否为外部模块，构造 genDynamicImport 包装的代码段
  const externalId = id.replace(/\?v=\w+$|^\/@fs/, '')

  if (await opts.isExternal(externalId)) {
    const path = builtinModules.includes(externalId.split('node:').pop()!)
      ? externalId
      : isAbsolute(externalId) ? pathToFileURL(externalId).href : externalId
    return {
      code: `(global, module, _, exports, importMeta, ssrImport, ssrDynamicImport, ssrExportAll) =>
${genDynamicImport(path, { wrapper: false })}
  .then(r => {
    if (r.default && r.default.__esModule)
      r = r.default
    exports.default = r.default
    ssrExportAll(r)
  })
  .catch(e => {
    console.error(e)
    throw new Error(${JSON.stringify(`[vite dev] Error loading external "${id}".`)})
  })`,
      deps: [],
      dynamicDeps: [],
    }
  }

  // Transform
  // 调用 Vite transformRequest 进行 SSR 转换
  const res: SSRTransformResult = await opts.viteServer.transformRequest(id, { ssr: true }).catch((err) => {
    logger.warn(`[SSR] Error transforming ${id}:`, err)
    // console.error(err)
  }) as SSRTransformResult || { code: '', map: {}, deps: [], dynamicDeps: [] }

  // Wrap into a vite module
  const code = `async function (global, module, exports, __vite_ssr_exports__, __vite_ssr_import_meta__, __vite_ssr_import__, __vite_ssr_dynamic_import__, __vite_ssr_exportAll__) {
${res.code || '/* empty */'};
}`
  return { code, deps: res.deps || [], dynamicDeps: res.dynamicDeps || [] }
}

// 递归处理依赖模块
async function transformRequestRecursive (opts: TransformOptions, id: string, parent = '<entry>', chunks: Record<string, TransformChunk> = {}) {
  if (chunks[id]) {
    chunks[id].parents.push(parent)
    return
  }
  const res = await transformRequest(opts, id)
  const deps = uniq([...res.deps, ...res.dynamicDeps])

  chunks[id] = {
    id,
    code: res.code,
    deps,
    parents: [parent],
  } as TransformChunk
  for (const dep of deps) {
    await transformRequestRecursive(opts, dep, id, chunks)
  }
  return Object.values(chunks)
}

// 打包入口模块及其所有依赖为 SSR 模块集合
async function bundleRequest (opts: TransformOptions, entryURL: string) {
  const chunks = (await transformRequestRecursive(opts, entryURL))!

  const listIds = (ids: string[]) => ids.map(id => `// - ${id} (${hashId(id)})`).join('\n')
  const chunksCode = chunks.map(chunk => `
// --------------------
// Request: ${chunk.id}
// Parents: \n${listIds(chunk.parents)}
// Dependencies: \n${listIds(chunk.deps)}
// --------------------
const ${hashId(chunk.id + '-' + chunk.code)} = ${chunk.code}
`).join('\n')

  // 生成模块映射（ID -> 函数名）
  const manifestCode = `const __modules__ = ${
    genObjectFromRawEntries(chunks.map(chunk => [chunk.id, hashId(chunk.id + '-' + chunk.code)]))
  }`

  // https://github.com/vitejs/vite/blob/main/packages/vite/src/node/ssr/ssrModuleLoader.ts
  // 注入 SSR 加载器代码，仿 Vite 的内部实现
  const ssrModuleLoader = `
const __pendingModules__ = new Map()
const __pendingImports__ = new Map()
const __ssrContext__ = { global: globalThis }

function __ssrLoadModule__(url, urlStack = []) {
  const pendingModule = __pendingModules__.get(url)
  if (pendingModule) { return pendingModule }
  const modulePromise = __instantiateModule__(url, urlStack)
  __pendingModules__.set(url, modulePromise)
  modulePromise.catch(() => { __pendingModules__.delete(url) })
         .finally(() => { __pendingModules__.delete(url) })
  return modulePromise
}

async function __instantiateModule__(url, urlStack) {
  const mod = __modules__[url]
  if (mod.stubModule) { return mod.stubModule }
  const stubModule = { [Symbol.toStringTag]: 'Module' }
  Object.defineProperty(stubModule, '__esModule', { value: true })
  mod.stubModule = stubModule
  // https://vitejs.dev/guide/api-hmr.html
  const importMeta = { url, hot: { accept() {}, prune() {}, dispose() {}, invalidate() {}, decline() {}, on() {} } }
  urlStack = urlStack.concat(url)
  const isCircular = url => urlStack.includes(url)
  const pendingDeps = []
  const ssrImport = async (dep) => {
    // TODO: Handle externals if dep[0] !== '.' | '/'
    if (!isCircular(dep) && !__pendingImports__.get(dep)?.some(isCircular)) {
      pendingDeps.push(dep)
      if (pendingDeps.length === 1) {
        __pendingImports__.set(url, pendingDeps)
      }
      await __ssrLoadModule__(dep, urlStack)
      if (pendingDeps.length === 1) {
        __pendingImports__.delete(url)
      } else {
        pendingDeps.splice(pendingDeps.indexOf(dep), 1)
      }
    }
    return __modules__[dep].stubModule
  }
  function ssrDynamicImport (dep) {
    // TODO: Handle dynamic import starting with . relative to url
    return ssrImport(dep)
  }

  function ssrExportAll(sourceModule) {
    for (const key in sourceModule) {
      if (key !== 'default') {
        try {
          Object.defineProperty(stubModule, key, {
            enumerable: true,
            configurable: true,
            get() { return sourceModule[key] }
          })
        } catch (_err) { }
      }
    }
  }

  const cjsModule = {
    get exports () {
      return stubModule.default
    },
    set exports (v) {
      stubModule.default = v
    },
  }

  await mod(
    __ssrContext__.global,
    cjsModule,
    stubModule.default,
    stubModule,
    importMeta,
    ssrImport,
    ssrDynamicImport,
    ssrExportAll
  )

  return stubModule
}
`

  // 合并最终输出代码
  const code = [
    chunksCode,
    manifestCode,
    ssrModuleLoader,
    `export default await __ssrLoadModule__(${JSON.stringify(entryURL)})`,
  ].join('\n\n')

  return {
    code,
    ids: chunks.map(i => i.id),
  }
}

// 构建并监听开发环境 SSR 模块
export async function initViteDevBundler (ctx: ViteBuildContext, onBuild: () => Promise<any>) {
  const viteServer = ctx.ssrServer!
  const options: TransformOptions = {
    viteServer,
    isExternal: createIsExternal(viteServer, ctx.nuxt),
  }

  // Build and watch
  // 实际构建逻辑，调用 bundleRequest + 写文件
  const _doBuild = async () => {
    const start = Date.now()
    const { code, ids } = await bundleRequest(options, ctx.entry)
    await writeFile(resolve(ctx.nuxt.options.buildDir, 'dist/server/server.mjs'), code, 'utf-8')
    // Have CSS in the manifest to prevent FOUC on dev SSR
    // 收集 CSS 资源，用于防止闪烁（FOUC）
    const manifestIds: string[] = []
    for (const i of ids) {
      if (isCSS(i)) {
        manifestIds.push(i.slice(1))
      }
    }
    await writeManifest(ctx, manifestIds)
    const time = (Date.now() - start)
    logger.success(`Vite server built in ${time}ms`)
    await onBuild()
  }
  const doBuild = debounce(_doBuild)

  // Initial build
  // 初始构建
  await _doBuild()

  // Watch
  // 监听文件变化（非忽略项），触发重新构建
  viteServer.watcher.on('all', (_event, file) => {
    file = normalize(file) // Fix windows paths
    if (file.indexOf(ctx.nuxt.options.buildDir) === 0 || isIgnored(file)) { return }
    doBuild()
  })
  // ctx.nuxt.hook('builder:watch', () => doBuild())
  ctx.nuxt.hook('app:templatesGenerated', () => doBuild())
}
