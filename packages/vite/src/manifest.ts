import { readFileSync } from 'node:fs'
// 从 Node.js 的 promises API 中导入异步创建目录、删除文件、写入文件的方法
import { mkdir, rm, writeFile } from 'node:fs/promises'

import { relative, resolve } from 'pathe'
// UFO 是 Nuxt 使用的 URL 工具包，导入用于路径清理的函数
import { withTrailingSlash, withoutLeadingSlash } from 'ufo'
// 将字符串转义为可安全用于正则表达式的形式
import escapeRE from 'escape-string-regexp'
// 用于将 Vite 的 manifest 转换为 vue-bundle-renderer 可用的格式
import { normalizeViteManifest } from 'vue-bundle-renderer'
// 类型导入：vue-bundle-renderer 的 manifest 类型
import type { Manifest as RendererManifest } from 'vue-bundle-renderer'
// 类型导入：Vite 的 manifest 类型
import type { Manifest as ViteClientManifest } from 'vite'
// 类型导入：ViteBuildContext，包含 Nuxt 和 Vite 的构建上下文
import type { ViteBuildContext } from './vite'

// 生成并写入 manifest 文件.用于生成并写入用于 SSR 的 manifest 文件，接收构建上下文 ctx 和一个 CSS 文件数组。
// 这个函数的作用是在 Nuxt 构建过程中，将 Vite 生成的客户端资源清单（manifest）处理并转换为 vue-bundle-renderer 可用的格式，再将其保存用于服务端渲染使用。
export async function writeManifest (ctx: ViteBuildContext, css: string[] = []) {
  // Write client manifest for use in vue-bundle-renderer
  // 准备路径
  const clientDist = resolve(ctx.nuxt.options.buildDir, 'dist/client')
  const serverDist = resolve(ctx.nuxt.options.buildDir, 'dist/server')

  // 开发模式下的临时 manifest 定义.
  // 如果是开发模式，不会有实际的 Vite 构建产物，所以这里手动构造一个 client manifest，包含 @vite/client 和入口文件。
  const devClientManifest: RendererManifest = {
    '@vite/client': {
      isEntry: true,
      file: '@vite/client',
      css,
      module: true,
      resourceType: 'script',
    },
    [ctx.entry]: {
      isEntry: true,
      file: ctx.entry,
      module: true,
      resourceType: 'script',
    },
  }

  // 获取实际的 client manifest
  // 如果是开发环境，使用上面的临时 manifest；
  // 如果是生产环境，从 dist/client/manifest.json 中读取实际构建生成的 manifest。
  const manifestFile = resolve(clientDist, 'manifest.json')
  const clientManifest = ctx.nuxt.options.dev
    ? devClientManifest
    : JSON.parse(readFileSync(manifestFile, 'utf-8')) as ViteClientManifest

  const manifestEntries = Object.values(clientManifest)

  // 移除路径中的前缀（如 _nuxt/）
  const buildAssetsDir = withTrailingSlash(withoutLeadingSlash(ctx.nuxt.options.app.buildAssetsDir))
  const BASE_RE = new RegExp(`^${escapeRE(buildAssetsDir)}`)

  // 提取所有 manifest 项；
  //
  // 生成一个正则，用来移除资源路径中类似 _nuxt/ 的前缀。
  // 遍历每个资源条目，移除路径中的 _nuxt/ 等 buildAssetsDir 前缀，确保 manifest 中路径统一。
  for (const entry of manifestEntries) {
    entry.file &&= entry.file.replace(BASE_RE, '')
    for (const item of ['css', 'assets'] as const) {
      entry[item] &&= entry[item].map((i: string) => i.replace(BASE_RE, ''))
    }
  }

  // 确保服务端输出目录存在
  await mkdir(serverDist, { recursive: true })

  // 如果关闭了 CSS 分离（cssCodeSplit: false），将所有 CSS 合并入入口文件
  // 如果没有使用 CSS 分离，查找 .css 文件并手动添加到入口文件的 CSS 字段中；
  //
  // key 是入口文件相对于项目根目录的路径。
  if (ctx.config.build?.cssCodeSplit === false) {
    for (const entry of manifestEntries) {
      if (entry.file?.endsWith('.css')) {
        const key = relative(ctx.config.root!, ctx.entry)
        clientManifest[key]!.css ||= []
        ;(clientManifest[key]!.css as string[]).push(entry.file)
        break
      }
    }
  }

  // 标准化 manifest 并写入服务端
  const manifest = normalizeViteManifest(clientManifest)
  await ctx.nuxt.callHook('build:manifest', manifest)
  const stringifiedManifest = JSON.stringify(manifest, null, 2)
  await writeFile(resolve(serverDist, 'client.manifest.json'), stringifiedManifest, 'utf8')
  await writeFile(resolve(serverDist, 'client.manifest.mjs'), 'export default ' + stringifiedManifest, 'utf8')

  if (!ctx.nuxt.options.dev) {
    await rm(manifestFile, { force: true })
  }
}
