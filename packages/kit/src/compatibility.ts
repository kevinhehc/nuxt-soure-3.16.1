import satisfies from 'semver/functions/satisfies.js' // npm/node-semver#381
import { readPackageJSON } from 'pkg-types'
import type { Nuxt, NuxtCompatibility, NuxtCompatibilityIssues } from '@nuxt/schema'
import { useNuxt } from './context'

// 用于检测当前 Nuxt 项目的版本、构建器、桥接情况，判断是否符合模块要求的兼容性工具。
//
// 主要应用场景是：
//
// 模块开发时检查 Nuxt 版本要求
//
// 插件动态启用或禁用
//
// 提前提示用户 Nuxt 环境不符合要求

const SEMANTIC_VERSION_RE = /-\d+\.[0-9a-f]+/
export function normalizeSemanticVersion (version: string) {
  return version.replace(SEMANTIC_VERSION_RE, '') // Remove edge prefix
}

const builderMap = {
  '@nuxt/rspack-builder': 'rspack',
  '@nuxt/vite-builder': 'vite',
  '@nuxt/webpack-builder': 'webpack',
}

export function checkNuxtVersion (version: string, nuxt: Nuxt = useNuxt()) {
  const nuxtVersion = getNuxtVersion(nuxt)
  return satisfies(normalizeSemanticVersion(nuxtVersion), version, { includePrerelease: true })
}

/**
 * Check version constraints and return incompatibility issues as an array
 */
export async function checkNuxtCompatibility (constraints: NuxtCompatibility, nuxt: Nuxt = useNuxt()): Promise<NuxtCompatibilityIssues> {
  const issues: NuxtCompatibilityIssues = []

  // Nuxt version check
  if (constraints.nuxt) {
    const nuxtVersion = getNuxtVersion(nuxt)
    if (!checkNuxtVersion(constraints.nuxt, nuxt)) {
      issues.push({
        name: 'nuxt',
        message: `Nuxt version \`${constraints.nuxt}\` is required but currently using \`${nuxtVersion}\``,
      })
    }
  }

  // Bridge compatibility check
  if (isNuxt2(nuxt)) {
    const bridgeRequirement = constraints.bridge
    const hasBridge = !!(nuxt.options as any).bridge
    if (bridgeRequirement === true && !hasBridge) {
      issues.push({
        name: 'bridge',
        message: 'Nuxt bridge is required',
      })
    } else if (bridgeRequirement === false && hasBridge) {
      issues.push({
        name: 'bridge',
        message: 'Nuxt bridge is not supported',
      })
    }
  }

  // Builder compatibility check
  if (constraints.builder && typeof nuxt.options.builder === 'string') {
    const currentBuilder = builderMap[nuxt.options.builder] || nuxt.options.builder
    if (currentBuilder in constraints.builder) {
      const constraint = constraints.builder[currentBuilder]!
      if (constraint === false) {
        issues.push({
          name: 'builder',
          message: `Not compatible with \`${nuxt.options.builder}\`.`,
        })
      } else {
        for (const parent of [nuxt.options.rootDir, nuxt.options.workspaceDir, import.meta.url]) {
          const builderVersion = await readPackageJSON(nuxt.options.builder, { parent }).then(r => r.version).catch(() => undefined)
          if (builderVersion) {
            if (!satisfies(normalizeSemanticVersion(builderVersion), constraint, { includePrerelease: true })) {
              issues.push({
                name: 'builder',
                message: `Not compatible with \`${builderVersion}\` of \`${currentBuilder}\`. This module requires \`${constraint}\`.`,
              })
            }
            break
          }
        }
      }
    }
  }

  // Allow extending compatibility checks
  await nuxt.callHook('kit:compatibility', constraints, issues)

  // Issues formatter
  issues.toString = () =>
    issues.map(issue => ` - [${issue.name}] ${issue.message}`).join('\n')

  return issues
}

/**
 * Check version constraints and throw a detailed error if has any, otherwise returns true
 */
export async function assertNuxtCompatibility (constraints: NuxtCompatibility, nuxt: Nuxt = useNuxt()): Promise<true> {
  const issues = await checkNuxtCompatibility(constraints, nuxt)
  if (issues.length) {
    throw new Error('Nuxt compatibility issues found:\n' + issues.toString())
  }
  return true
}

/**
 * Check version constraints and return true if passed, otherwise returns false
 */
export async function hasNuxtCompatibility (constraints: NuxtCompatibility, nuxt: Nuxt = useNuxt()): Promise<boolean> {
  const issues = await checkNuxtCompatibility(constraints, nuxt)
  return !issues.length
}

/**
 * Check if current Nuxt instance is of specified major version
 */
export function isNuxtMajorVersion (majorVersion: 2 | 3 | 4, nuxt: Nuxt = useNuxt()) {
  const version = getNuxtVersion(nuxt)

  return version[0] === majorVersion.toString() && version[1] === '.'
}

/**
 * @deprecated Use `isNuxtMajorVersion(2, nuxt)` instead. This may be removed in \@nuxt/kit v5 or a future major version.
 */
export function isNuxt2 (nuxt: Nuxt = useNuxt()) {
  return isNuxtMajorVersion(2, nuxt)
}

/**
 * @deprecated Use `isNuxtMajorVersion(3, nuxt)` instead. This may be removed in \@nuxt/kit v5 or a future major version.
 */
export function isNuxt3 (nuxt: Nuxt = useNuxt()) {
  return isNuxtMajorVersion(3, nuxt)
}

const NUXT_VERSION_RE = /^v/g
/**
 * Get nuxt version
 */
export function getNuxtVersion (nuxt: Nuxt | any = useNuxt() /* TODO: LegacyNuxt */) {
  const rawVersion = nuxt?._version || nuxt?.version || nuxt?.constructor?.version
  if (typeof rawVersion !== 'string') {
    throw new TypeError('Cannot determine nuxt version! Is current instance passed?')
  }
  return rawVersion.replace(NUXT_VERSION_RE, '')
}
