import type { AsyncLocalStorage } from 'node:async_hooks'
import type { Hookable } from 'hookable'
import type { Ignore } from 'ignore'
import type { NuxtModule } from './module'
import type { NuxtHooks, NuxtLayout, NuxtMiddleware, NuxtPage } from './hooks'
import type { Component } from './components'
import type { NuxtOptions } from './config'
import type { NuxtDebugContext } from './debug'

export interface NuxtPlugin {
  /** @deprecated use mode */
  ssr?: boolean
  src: string
  mode?: 'all' | 'server' | 'client'
  /**
   * This allows more granular control over plugin order and should only be used by advanced users.
   * Lower numbers run first, and user plugins default to `0`.
   *
   * Default Nuxt priorities can be seen at [here](https://github.com/nuxt/nuxt/blob/9904849bc87c53dfbd3ea3528140a5684c63c8d8/packages/nuxt/src/core/plugins/plugin-metadata.ts#L15-L34).
   */
  order?: number
  /**
   * @internal
   */
  name?: string
}

// Internal type for simpler NuxtTemplate interface extension

type TemplateDefaultOptions = Record<string, any>

// NuxtTemplate
export interface NuxtTemplate<Options = TemplateDefaultOptions> {
  /** resolved output file path (generated) */
  // 目标文件的路径。如果未提供 dst，它将从 filename 路径和 nuxt buildDir 选项生成。
  dst?: string
  /** The target filename once the template is copied into the Nuxt buildDir */
  // 模板的文件名。如果未提供 filename，它将从 src 路径生成。在这种情况下，src 选项是必需的。
  filename?: string
  /** An options object that will be accessible within the template via `<% options %>` */
  // 传递给模板的选项。
  options?: Options
  /** The resolved path to the source file to be template */
  // 模板的路径。如果未提供 src，则必须提供 getContents
  src?: string
  /** Provided compile option instead of src */
  // 一个将使用 options 对象调用的函数。它应该返回一个字符串或一个解析为字符串的 Promise。如果提供了 src，则将忽略此函数。
  getContents?: (data: { nuxt: Nuxt, app: NuxtApp, options: Options }) => string | Promise<string>
  /** Write to filesystem */
  // 如果设置为 true，模板将被写入目标文件。否则，模板将仅在虚拟文件系统中使用。
  write?: boolean
  /**
   * The source path of the template (to try resolving dependencies from).
   * @internal
   */
  _path?: string
}

export interface NuxtServerTemplate {
  /** The target filename once the template is copied into the Nuxt buildDir */
  filename: string
  getContents: () => string | Promise<string>
}

export interface ResolvedNuxtTemplate<Options = TemplateDefaultOptions> extends NuxtTemplate<Options> {
  filename: string
  dst: string
  modified?: boolean
}

export interface NuxtTypeTemplate<Options = TemplateDefaultOptions> extends Omit<NuxtTemplate<Options>, 'write' | 'filename'> {
  filename: `${string}.d.ts`
  write?: true
}

type _TemplatePlugin<Options> = Omit<NuxtPlugin, 'src'> & NuxtTemplate<Options>
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface NuxtPluginTemplate<Options = TemplateDefaultOptions> extends _TemplatePlugin<Options> { }

export interface NuxtApp {
  mainComponent?: string | null
  rootComponent?: string | null
  errorComponent?: string | null
  dir: string
  extensions: string[]
  plugins: NuxtPlugin[]
  components: Component[]
  layouts: Record<string, NuxtLayout>
  middleware: NuxtMiddleware[]
  templates: NuxtTemplate[]
  configs: string[]
  pages?: NuxtPage[]
}

export interface Nuxt {
  // Private fields.
  __name: string
  _version: string
  _ignore?: Ignore
  _dependencies?: Set<string>
  _debug?: NuxtDebugContext
  /** Async local storage for current running Nuxt module instance. */
  _asyncLocalStorageModule?: AsyncLocalStorage<NuxtModule>

  /** The resolved Nuxt configuration. */
  options: NuxtOptions
  hooks: Hookable<NuxtHooks>
  hook: Nuxt['hooks']['hook']
  callHook: Nuxt['hooks']['callHook']
  addHooks: Nuxt['hooks']['addHooks']
  runWithContext: <T extends (...args: any[]) => any>(fn: T) => ReturnType<T>

  ready: () => Promise<void>
  close: () => Promise<void>

  /** The production or development server. */
  server?: any

  vfs: Record<string, string>

  apps: Record<string, NuxtApp>
}
