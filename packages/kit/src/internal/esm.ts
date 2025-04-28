import { pathToFileURL } from 'node:url'
import { interopDefault } from 'mlly'
// 从一个起点路径（from）出发，根据模块 ID (id) 去解析模块物理文件位置。
// 支持多种文件扩展名（suffixes、extensions）：
// 比如 .js, .ts, .mjs, .cjs, .json
// 支持自动补齐目录索引（index.js）：
// 如果找不到直接文件，可以自动 fallback 到 id/index.js。
// 支持尝试模式（try: true）：
// 如果找不到模块，不抛异常，而是返回 undefined。
// 支持 file:// URL 起点（兼容 Node 20+的 file URL 解析）
// 内部可能支持基于 exports 字段的 package.json module resolution（现代规范）
// 可以处理 ESM / CJS 混合包。
// 跨平台兼容（统一 / 和 \ 分隔符）。
import { resolveModulePath } from 'exsolve'
import { createJiti } from 'jiti'

export interface ResolveModuleOptions {
  /** @deprecated use `url` with URLs pointing at a file - never a directory */
  paths?: string | string[]
  url?: URL | URL[]
}

// directoryToURL('/path/to/dir')
// // -> file:///path/to/dir/
export function directoryToURL (dir: string): URL {
  return pathToFileURL(dir + '/')
}

/**
 * Resolve a module from a given root path using an algorithm patterned on
 * the upcoming `import.meta.resolve`. It returns a file URL
 *
 * @internal
 *
 * 根据一个模块 ID（比如 'vue' 或 './foo.js'）和给定的 URL/路径，尝试解析模块物理路径。
 * 不保证一定解析成功（失败不会抛错，返回 undefined）。
 * 内部用 resolveModulePath 来实现，带了 try: true。
 */
export async function tryResolveModule (id: string, url: URL | URL[]): Promise<string | undefined>
/** @deprecated pass URLs pointing at files */
export function tryResolveModule (id: string, url: string | string[]): Promise<string | undefined>
export function tryResolveModule (id: string, url: string | string[] | URL | URL[] = import.meta.url) {
  return Promise.resolve(resolveModulePath(id, {
    from: url,
    suffixes: ['', 'index'],
    try: true,
  }))
}

// 同样是解析模块路径，但这个是严格模式，
// 如果模块找不到，会直接抛错。
// 同时支持处理 .js, .ts, .mjs, .cjs 等后缀。
export function resolveModule (id: string, options?: ResolveModuleOptions) {
  return resolveModulePath(id, {
    from: options?.url ?? options?.paths ?? [import.meta.url],
    extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
  })
}

export interface ImportModuleOptions extends ResolveModuleOptions {
  /** Automatically de-default the result of requiring the module. */
  interopDefault?: boolean
}

// 主力函数，作用是：
// 调用 resolveModule 找到模块文件
// 用原生 import() 动态导入模块
// 根据 interopDefault 选项，处理默认导出：
// export default xxx -> xxx
// { default: xxx } -> xxx
// 一般情况下，建议使用这个方法来动态加载模块。
export async function importModule<T = unknown> (id: string, opts?: ImportModuleOptions) {
  const resolvedPath = resolveModule(id, opts)
  return await import(pathToFileURL(resolvedPath).href).then(r => opts?.interopDefault !== false ? interopDefault(r) : r) as Promise<T>
}

// 在 importModule 的基础上，提供一个安全版：
// 如果导入失败，返回 undefined，不会抛异常。
// 常用于某些模块是可选依赖（optional dependency）的场景。
export function tryImportModule<T = unknown> (id: string, opts?: ImportModuleOptions) {
  try {
    return importModule<T>(id, opts).catch(() => undefined)
  } catch {
    // intentionally empty as this is a `try-` function
  }
}

const warnings = new Set<string>()

/**
 * @deprecated Please use `importModule` instead.
 */
// 为了兼容旧版本 Nuxt，提供一个基于 jiti 的 require() 风格的动态导入：
// 调用 resolveModule
// 用 jiti 模拟 require 语法来加载模块
// 支持自动 interopDefault
// 不过这个方法已经标记为 deprecated，官方建议用 importModule 替代。
export function requireModule<T = unknown> (id: string, opts?: ImportModuleOptions) {
  if (!warnings.has(id)) {
    // TODO: add more information on stack trace
    console.warn('[@nuxt/kit] `requireModule` is deprecated. Please use `importModule` instead.')
    warnings.add(id)
  }
  const resolvedPath = resolveModule(id, opts)
  const jiti = createJiti(import.meta.url, {
    interopDefault: opts?.interopDefault !== false,
  })
  return jiti(pathToFileURL(resolvedPath).href) as T
}

/**
 * @deprecated Please use `tryImportModule` instead.
 */
export function tryRequireModule<T = unknown> (id: string, opts?: ImportModuleOptions) {
  try {
    return requireModule<T>(id, opts)
  } catch {
    // intentionally empty as this is a `try-` function
  }
}
