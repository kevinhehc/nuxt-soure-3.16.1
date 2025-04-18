import { pathToFileURL } from 'node:url'
import type { Nuxt } from '@nuxt/schema'
import { resolveModulePath } from 'exsolve'
import { interopDefault } from 'mlly'
import { readPackageJSON } from 'pkg-types'
import { directoryToURL, importModule, tryImportModule } from '../internal/esm'
import { runWithNuxtContext } from '../context'
import type { LoadNuxtConfigOptions } from './config'

export interface LoadNuxtOptions extends LoadNuxtConfigOptions {
  /** Load nuxt with development mode */
  dev?: boolean

  /** Use lazy initialization of nuxt if set to false */
  ready?: boolean

  /** @deprecated Use cwd option */
  rootDir?: LoadNuxtConfigOptions['cwd']

  /** @deprecated use overrides option */
  config?: LoadNuxtConfigOptions['overrides']
}

export async function loadNuxt (opts: LoadNuxtOptions): Promise<Nuxt> {
  // Backward compatibility
  opts.cwd ||= opts.rootDir
  opts.overrides ||= opts.config || {}

  // Apply dev as config override
  opts.overrides.dev = !!opts.dev

  const resolvedPath = ['nuxt-nightly', 'nuxt3', 'nuxt', 'nuxt-edge']
    .map(pkg => resolveModulePath(pkg, { try: true, from: [directoryToURL(opts.cwd!)] }))
    .filter((p): p is NonNullable<typeof p> => !!p)
    .sort((a, b) => b.length - a.length)[0]

  if (!resolvedPath) {
    throw new Error(`Cannot find any nuxt version from ${opts.cwd}`)
  }
  const pkg = await readPackageJSON(resolvedPath)
  const majorVersion = pkg.version ? Number.parseInt(pkg.version.split('.')[0]!) : ''

  // Nuxt 3
  if (majorVersion && majorVersion >= 3) {
    const { loadNuxt } = await import(pathToFileURL(resolvedPath).href).then(r => interopDefault(r)) as typeof import('nuxt')
    const nuxt = await loadNuxt(opts)
    return nuxt
  }

  // Nuxt 2
  const rootURL = directoryToURL(opts.cwd!)
  const { loadNuxt } = await tryImportModule<{ loadNuxt: any }>('nuxt-edge', { url: rootURL }) || await importModule<{ loadNuxt: any }>('nuxt', { url: rootURL })
  const nuxt = await loadNuxt({
    rootDir: opts.cwd,
    for: opts.dev ? 'dev' : 'build',
    configOverrides: opts.overrides,
    ready: opts.ready,
    envConfig: opts.dotenv, // TODO: Backward format conversion
  })

  // Mock new hookable methods
  nuxt.removeHook ||= nuxt.clearHook.bind(nuxt)
  nuxt.removeAllHooks ||= nuxt.clearHooks.bind(nuxt)
  nuxt.hookOnce ||= (name: string, fn: (...args: any[]) => any, ...hookArgs: any[]) => {
    const unsub = nuxt.hook(name, (...args: any[]) => {
      unsub()
      return fn(...args)
    }, ...hookArgs)
    return unsub
  }
  // https://github.com/nuxt/nuxt/tree/main/packages/kit/src/module/define.ts#L111-L113
  nuxt.hooks ||= nuxt

  return nuxt as Nuxt
}

export async function buildNuxt (nuxt: Nuxt): Promise<any> {
  const rootURL = directoryToURL(nuxt.options.rootDir)

  // Nuxt 3
  if (nuxt.options._majorVersion === 3) {
    const { build } = await tryImportModule<typeof import('nuxt')>('nuxt-nightly', { url: rootURL }) || await tryImportModule<typeof import('nuxt')>('nuxt3', { url: rootURL }) || await importModule<typeof import('nuxt')>('nuxt', { url: rootURL })
    return runWithNuxtContext(nuxt, () => build(nuxt))
  }

  // Nuxt 2
  const { build } = await tryImportModule<{ build: any }>('nuxt-edge', { url: rootURL }) || await importModule<{ build: any }>('nuxt', { url: rootURL })
  return runWithNuxtContext(nuxt, () => build(nuxt))
}
