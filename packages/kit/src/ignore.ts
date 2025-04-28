import { existsSync, readFileSync } from 'node:fs'
import ignore from 'ignore'
import { join, relative, resolve } from 'pathe'
import { tryUseNuxt } from './context'

// 用于根据 .nuxtignore 文件和项目配置，判断某个文件路径是否应该被忽略。
//
// 主要功能就是：
//
// 自动读取 .nuxtignore
//
// 结合 nuxt.config.ts 里的 ignore 配置项
//
// 提供统一的 isIgnored(path) 检查函数
//
// 这套逻辑可以用于：
//
// Dev server 监听时排除某些文件变化
//
// Build 阶段忽略某些文件
//
// Lint、生成等场景跳过无关文件

export function createIsIgnored (nuxt = tryUseNuxt()) {
  return (pathname: string, stats?: unknown) => isIgnored(pathname, stats, nuxt)
}

/**
 * Return a filter function to filter an array of paths
 */
export function isIgnored (pathname: string, _stats?: unknown, nuxt = tryUseNuxt()): boolean {
  // Happens with CLI reloads
  if (!nuxt) {
    return false
  }

  if (!nuxt._ignore) {
    nuxt._ignore = ignore(nuxt.options.ignoreOptions)
    nuxt._ignore.add(resolveIgnorePatterns())
  }

  const cwds = nuxt.options._layers?.map(layer => layer.cwd).sort((a, b) => b.length - a.length)
  const layer = cwds?.find(cwd => pathname.startsWith(cwd))
  const relativePath = relative(layer ?? nuxt.options.rootDir, pathname)
  if (relativePath[0] === '.' && relativePath[1] === '.') {
    return false
  }
  return !!(relativePath && nuxt._ignore.ignores(relativePath))
}

const NEGATION_RE = /^(!?)(.*)$/

export function resolveIgnorePatterns (relativePath?: string): string[] {
  const nuxt = tryUseNuxt()

  // Happens with CLI reloads
  if (!nuxt) {
    return []
  }

  const ignorePatterns = nuxt.options.ignore.flatMap(s => resolveGroupSyntax(s))

  const nuxtignoreFile = join(nuxt.options.rootDir, '.nuxtignore')
  if (existsSync(nuxtignoreFile)) {
    const contents = readFileSync(nuxtignoreFile, 'utf-8')
    ignorePatterns.push(...contents.trim().split(/\r?\n/))
  }

  if (relativePath) {
    // Map ignore patterns based on if they start with * or !*
    return ignorePatterns.map((p) => {
      const [_, negation = '', pattern] = p.match(NEGATION_RE) || []
      if (pattern && pattern[0] === '*') {
        return p
      }
      return negation + relative(relativePath, resolve(nuxt.options.rootDir, pattern || p))
    })
  }

  return ignorePatterns
}

/**
 * This function turns string containing groups '**\/*.{spec,test}.{js,ts}' into an array of strings.
 * For example will '**\/*.{spec,test}.{js,ts}' be resolved to:
 * ['**\/*.spec.js', '**\/*.spec.ts', '**\/*.test.js', '**\/*.test.ts']
 * @param group string containing the group syntax
 * @returns {string[]} array of strings without the group syntax
 */
export function resolveGroupSyntax (group: string): string[] {
  let groups = [group]
  while (groups.some(group => group.includes('{'))) {
    groups = groups.flatMap((group) => {
      const [head, ...tail] = group.split('{')
      if (tail.length) {
        const [body = '', ...rest] = tail.join('{').split('}')
        return body.split(',').map(part => `${head}${part}${rest.join('')}`)
      }

      return group
    })
  }
  return groups
}
