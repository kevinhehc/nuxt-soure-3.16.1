import type { Import } from 'unimport'
import type { ImportPresetWithDeprecation } from '@nuxt/schema'
import { useNuxt } from './context'
import { assertNuxtCompatibility } from './compatibility'
import { toArray } from './utils'

// 用于在模块或插件中动态添加自动导入（auto-imports）的工具方法。
//
// 主要应用场景：
//
// 给 Nuxt 的自动导入系统注册新的函数、库或者目录。
//
// 模块开发时自动扩展用户可用的全局函数。

export function addImports (imports: Import | Import[]) {
  assertNuxtCompatibility({ bridge: true })

  useNuxt().hook('imports:extend', (_imports) => {
    _imports.push(...toArray(imports))
  })
}

export function addImportsDir (dirs: string | string[], opts: { prepend?: boolean } = {}) {
  assertNuxtCompatibility({ bridge: true })

  useNuxt().hook('imports:dirs', (_dirs: string[]) => {
    for (const dir of toArray(dirs)) {
      _dirs[opts.prepend ? 'unshift' : 'push'](dir)
    }
  })
}
export function addImportsSources (presets: ImportPresetWithDeprecation | ImportPresetWithDeprecation[]) {
  assertNuxtCompatibility({ bridge: true })

  useNuxt().hook('imports:sources', (_presets: ImportPresetWithDeprecation[]) => {
    for (const preset of toArray(presets)) {
      _presets.push(preset)
    }
  })
}
