import { existsSync, promises as fsp, lstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ModuleMeta, Nuxt, NuxtConfig, NuxtModule } from '@nuxt/schema'
import { dirname, isAbsolute, resolve } from 'pathe'
import { defu } from 'defu'
import { createJiti } from 'jiti'
import { parseNodeModulePath } from 'mlly'
import { resolveModuleURL } from 'exsolve'
import { isRelative } from 'ufo'
import { isNuxt2 } from '../compatibility'
import { directoryToURL } from '../internal/esm'
import { useNuxt } from '../context'
import { resolveAlias } from '../resolve'

// 动态安装并执行一个 Nuxt Module 的完整流程。
//
// 也就是说，在 Nuxt 项目启动时，或者在模块开发时，
// 如果要加载并安装一个模块（比如 @nuxt/image、nuxt-security），就会走这套逻辑。


const NODE_MODULES_RE = /[/\\]node_modules[/\\]/

/** Installs a module on a Nuxt instance. */
// moduleToInstall：模块名字（string）或者模块函数（NuxtModule）
// inlineOptions：给模块传的配置参数
// nuxt：当前的 Nuxt 实例（默认用 useNuxt()）
export async function installModule<
  T extends string | NuxtModule,
  Config extends Extract<NonNullable<NuxtConfig['modules']>[number], [T, any]>,
> (moduleToInstall: T, inlineOptions?: [Config] extends [never] ? any : Config[1], nuxt: Nuxt = useNuxt()) {
  // 1、加载模块实例
  //       调用 loadNuxtModuleInstance，解析模块路径并真正 import 模块代码。
  // 2、处理本地 layer module 目录
  //       把 layers/*/modules/ 路径收集起来，避免后续误判。
  //
  // 3、执行模块函数
  //      如果是 Nuxt 2：调用 moduleContainer
  //      如果是 Nuxt 3，且开启 debugModuleMutation：用 asyncLocalStorage 执行
  //      正常情况下：直接执行 nuxtModule(inlineOptions, nuxt)
  // 4、记录模块路径、transpile路径、modulesDir
  //      标准化模块目录并加到 build.transpile 和 modulesDir。
  // 5、记录模块安装到 _installedModules
  //      保存模块的 meta 信息、setup耗时（timings）、入口路径（entryPath）。
  const { nuxtModule, buildTimeModuleMeta, resolvedModulePath } = await loadNuxtModuleInstance(moduleToInstall, nuxt)

  const localLayerModuleDirs: string[] = []
  for (const l of nuxt.options._layers) {
    const srcDir = l.config.srcDir || l.cwd
    if (!NODE_MODULES_RE.test(srcDir)) {
      localLayerModuleDirs.push(resolve(srcDir, l.config?.dir?.modules || 'modules').replace(/\/?$/, '/'))
    }
  }

  // Call module
  const res = (
    isNuxt2()
      // @ts-expect-error Nuxt 2 `moduleContainer` is not typed
      ? await nuxtModule.call(nuxt.moduleContainer, inlineOptions, nuxt)
      : nuxt.options.experimental?.debugModuleMutation && nuxt._asyncLocalStorageModule
        ? await nuxt._asyncLocalStorageModule.run(nuxtModule, () => nuxtModule(inlineOptions || {}, nuxt))
        : await nuxtModule(inlineOptions || {}, nuxt)
  ) ?? {}
  if (res === false /* setup aborted */) {
    return
  }

  const modulePath = resolvedModulePath || moduleToInstall
  if (typeof modulePath === 'string') {
    const parsed = parseNodeModulePath(modulePath)
    const moduleRoot = parsed.dir ? parsed.dir + parsed.name : modulePath
    nuxt.options.build.transpile.push(normalizeModuleTranspilePath(moduleRoot))
    const directory = (parsed.dir ? moduleRoot : getDirectory(modulePath)).replace(/\/?$/, '/')
    if (directory !== moduleToInstall && !localLayerModuleDirs.some(dir => directory.startsWith(dir))) {
      nuxt.options.modulesDir.push(resolve(directory, 'node_modules'))
    }
  }

  nuxt.options._installedModules ||= []
  const entryPath = typeof moduleToInstall === 'string' ? resolveAlias(moduleToInstall) : undefined

  if (typeof moduleToInstall === 'string' && entryPath !== moduleToInstall) {
    buildTimeModuleMeta.rawPath = moduleToInstall
  }

  nuxt.options._installedModules.push({
    meta: defu(await nuxtModule.getMeta?.(), buildTimeModuleMeta),
    module: nuxtModule,
    timings: res.timings,
    entryPath,
  })
}

// --- Internal ---
// 给定一个路径，
// 如果是文件路径（比如 /node_modules/foo/index.js），返回对应目录（/node_modules/foo）。
// 如果是目录本身，直接返回。
// 主要用于确定 transpile 的根路径。
export function getDirectory (p: string) {
  try {
    // we need to target directories instead of module file paths themselves
    // /home/user/project/node_modules/module/index.js -> /home/user/project/node_modules/module
    return isAbsolute(p) && lstatSync(p).isFile() ? dirname(p) : p
  } catch {
    // maybe the path is absolute but does not exist, allow this to bubble up
  }
  return p
}

// 对于一个模块路径，
// 取出 node_modules/ 后面的部分，作为 transpile 的路径。
// 比如 /node_modules/@nuxt/image/dist/index.js -> @nuxt/image
export const normalizeModuleTranspilePath = (p: string) => {
  return getDirectory(p).split('node_modules/').pop() as string
}

const MissingModuleMatcher = /Cannot find module\s+['"]?([^'")\s]+)['"]?/i

// 输入：
// 模块名字或模块函数
// 当前 Nuxt 实例
//
// 主要流程：
// 如果是函数
//    直接返回（这是已经标准化好的模块）。
// 如果是字符串
// 解析路径（支持别名 alias）
// 解析为绝对路径（file URL）
// 用 jiti 动态 import 模块
// 校验模块必须是一个函数
// 检查有没有 module.json 文件（存版本信息），如果有读出来作为 buildTimeMeta。
// 异常处理
// 如果模块加载失败，明确给出错误提示，比如 "模块未安装"。
export async function loadNuxtModuleInstance (nuxtModule: string | NuxtModule, nuxt: Nuxt = useNuxt()): Promise<{ nuxtModule: NuxtModule<any>, buildTimeModuleMeta: ModuleMeta, resolvedModulePath?: string }> {
  let buildTimeModuleMeta: ModuleMeta = {}

  if (typeof nuxtModule === 'function') {
    return {
      nuxtModule,
      buildTimeModuleMeta,
    }
  }

  if (typeof nuxtModule !== 'string') {
    throw new TypeError(`Nuxt module should be a function or a string to import. Received: ${nuxtModule}.`)
  }

  const jiti = createJiti(nuxt.options.rootDir, { alias: nuxt.options.alias })

  // Import if input is string
  nuxtModule = resolveAlias(nuxtModule, nuxt.options.alias)

  if (isRelative(nuxtModule)) {
    nuxtModule = resolve(nuxt.options.rootDir, nuxtModule)
  }

  try {
    const src = resolveModuleURL(nuxtModule, {
      from: nuxt.options.modulesDir.map(m => directoryToURL(m.replace(/\/node_modules\/?$/, '/'))),
      suffixes: ['nuxt', 'nuxt/index', 'module', 'module/index', '', 'index'],
      extensions: ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'],
    })
    const resolvedModulePath = fileURLToPath(src)
    const resolvedNuxtModule = await jiti.import<NuxtModule<any>>(src, { default: true })

    if (typeof resolvedNuxtModule !== 'function') {
      throw new TypeError(`Nuxt module should be a function: ${nuxtModule}.`)
    }

    // nuxt-module-builder generates a module.json with metadata including the version
    const moduleMetadataPath = new URL('module.json', src)
    if (existsSync(moduleMetadataPath)) {
      buildTimeModuleMeta = JSON.parse(await fsp.readFile(moduleMetadataPath, 'utf-8'))
    }

    return { nuxtModule: resolvedNuxtModule, buildTimeModuleMeta, resolvedModulePath }
  } catch (error: unknown) {
    const code = (error as Error & { code?: string }).code
    if (code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' || code === 'ERR_UNSUPPORTED_DIR_IMPORT' || code === 'ENOTDIR') {
      throw new TypeError(`Could not load \`${nuxtModule}\`. Is it installed?`)
    }
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      const module = MissingModuleMatcher.exec((error as Error).message)?.[1]
      // verify that it's missing the nuxt module otherwise it may be a sub dependency of the module itself
      // i.e module is importing a module that is missing
      if (module && !module.includes(nuxtModule as string)) {
        throw new TypeError(`Error while importing module \`${nuxtModule}\`: ${error}`)
      }
    }
  }

  throw new TypeError(`Could not load \`${nuxtModule}\`. Is it installed?`)
}
