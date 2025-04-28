import satisfies from 'semver/functions/satisfies.js' // npm/node-semver#381
import type { Nuxt, NuxtModule, NuxtOptions } from '@nuxt/schema'
import { useNuxt } from '../context'
import { normalizeSemanticVersion } from '../compatibility'
import { loadNuxtModuleInstance } from './install'

// 输入是 Nuxt 配置 modules 里的单个模块项（可以是 string、array 或 object）。
// 递归提取出模块的名字（string）。
// 用来规范化模块名字，方便后面统一比较。
function resolveNuxtModuleEntryName (m: NuxtOptions['modules'][number]): string | false {
  if (typeof m === 'object' && !Array.isArray(m)) {
    return (m as any as NuxtModule).name
  }
  if (Array.isArray(m)) {
    return resolveNuxtModuleEntryName(m[0])
  }
  return m as string || false
}

/**
 * Check if a Nuxt module is installed by name.
 *
 * This will check both the installed modules and the modules to be installed. Note
 * that it cannot detect if a module is _going to be_ installed programmatically by another module.
 */
// 查一个模块是否存在。
//
// 检查两种情况：
// nuxt.options._installedModules：已经安装的模块列表。
// nuxt.options.modules：配置里声明的待安装模块列表。
// 返回 true/false。
export function hasNuxtModule (moduleName: string, nuxt: Nuxt = useNuxt()): boolean {
  // check installed modules
  return nuxt.options._installedModules.some(({ meta }) => meta.name === moduleName) ||
    // check modules to be installed
    nuxt.options.modules.some(m => moduleName === resolveNuxtModuleEntryName(m))
}

/**
 * Checks if a Nuxt Module is compatible with a given semver version.
 */
// 检查一个模块是否存在，并且版本是否符合指定的 semver 版本要求。
// 内部调用 getNuxtModuleVersion() 获取实际版本号。
// 再用 satisfies() 来判断版本兼容性（支持预发布版）。
export async function hasNuxtModuleCompatibility (module: string | NuxtModule, semverVersion: string, nuxt: Nuxt = useNuxt()): Promise<boolean> {
  const version = await getNuxtModuleVersion(module, nuxt)
  if (!version) {
    return false
  }
  return satisfies(normalizeSemanticVersion(version), semverVersion, {
    includePrerelease: true,
  })
}

/**
 * Get the version of a Nuxt module.
 *
 * Scans installed modules for the version, if it's not found it will attempt to load the module instance and get the version from there.
 */
// 获取指定模块的版本号。
// 先看模块自带的 meta 信息 (getMeta 方法或 meta.version)。
// 如果找不到，再去 nuxt.options._installedModules 里找。
// 如果还找不到，并且模块存在配置声明，预加载模块实例（loadNuxtModuleInstance）并尝试拿到版本。
// 最后返回模块版本字符串或 false。
export async function getNuxtModuleVersion (module: string | NuxtModule, nuxt: Nuxt | any = useNuxt()): Promise<string | false> {
  const moduleMeta = (typeof module === 'string' ? { name: module } : await module.getMeta?.()) || {}
  if (moduleMeta.version) { return moduleMeta.version }
  // need a name from here
  if (!moduleMeta.name) { return false }
  // maybe the version got attached within the installed module instance?
  for (const m of nuxt.options._installedModules) {
    if (m.meta.name === moduleMeta.name && m.meta.version) {
      return m.meta.version
    }
  }
  // it's possible that the module will be installed, it just hasn't been done yet, preemptively load the instance
  if (hasNuxtModule(moduleMeta.name)) {
    const { nuxtModule, buildTimeModuleMeta } = await loadNuxtModuleInstance(moduleMeta.name, nuxt)
    return buildTimeModuleMeta.version || await nuxtModule.getMeta?.().then(r => r.version) || false
  }
  return false
}
