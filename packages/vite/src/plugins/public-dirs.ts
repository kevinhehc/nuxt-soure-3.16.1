// 从 Node.js 的 fs 模块引入 existsSync，用于检查文件是否存在
import { existsSync } from 'node:fs'
// 从 Nuxt 的 kit 工具中引入 useNitro 获取 Nitro 配置
import { useNitro } from '@nuxt/kit'
// 使用 unplugin 创建 Vite 插件
import { createUnplugin } from 'unplugin'
import type { UnpluginOptions } from 'unplugin'
// UFO 提供 URL 工具
import { withLeadingSlash, withTrailingSlash } from 'ufo'
// 路径处理库 pathe
import { dirname, relative } from 'pathe'
// MagicString 用于安全地修改字符串（保留 source map）
import MagicString from 'magic-string'
// 判断是否是 CSS 请求
import { isCSSRequest } from 'vite'

// 虚拟模块前缀，用于替代真实路径
const PREFIX = 'virtual:public?'
// 用于匹配 CSS 中 url(/xx.png) 的正则表达式
const CSS_URL_RE = /url\((\/[^)]+)\)/g
const CSS_URL_SINGLE_RE = /url\(\/[^)]+\)/
// 匹配 renderChunk 中赋值语句的引号字符
const RENDER_CHUNK_RE = /(?<= = )['"`]/

// 插件可选参数类型
interface VitePublicDirsPluginOptions {
  dev?: boolean
  sourcemap?: boolean
  baseURL?: string
}

export const VitePublicDirsPlugin = createUnplugin((options: VitePublicDirsPluginOptions) => {
  const { resolveFromPublicAssets } = useResolveFromPublicAssets()

  // 开发环境专用插件：动态替换 CSS 中的路径
  const devTransformPlugin: UnpluginOptions = {
    name: 'nuxt:vite-public-dir-resolution-dev',
    vite: {
      transform (code, id) {
        if (!isCSSRequest(id) || !CSS_URL_SINGLE_RE.test(code)) { return }

        const s = new MagicString(code)
        for (const [full, url] of code.matchAll(CSS_URL_RE)) {
          if (url && resolveFromPublicAssets(url)) {
            // 替换为 baseURL 前缀路径
            s.replace(full, `url(${options.baseURL}${url})`)
          }
        }

        if (s.hasChanged()) {
          return {
            code: s.toString(),
            map: options.sourcemap ? s.generateMap({ hires: true }) : undefined,
          }
        }
      },
    },
  }

  // 返回插件数组，根据条件启用开发模式插件
  return [
    ...(options.dev && options.baseURL && options.baseURL !== '/' ? [devTransformPlugin] : []),
    {
      name: 'nuxt:vite-public-dir-resolution',
      vite: {
        // 虚拟模块加载器
        load: {
          enforce: 'pre',
          handler (id) {
            if (id.startsWith(PREFIX)) {
              return `import { publicAssetsURL } from '#internal/nuxt/paths';export default publicAssetsURL(${JSON.stringify(decodeURIComponent(id.slice(PREFIX.length)))})`
            }
          },
        },
        // 模块路径解析器：将真实路径转换为虚拟模块路径
        resolveId: {
          enforce: 'post',
          handler (id) {
            if (id === '/__skip_vite' || id[0] !== '/' || id.startsWith('/@fs')) { return }

            if (resolveFromPublicAssets(id)) {
              return PREFIX + encodeURIComponent(id)
            }
          },
        },
        // 构建 chunk 的钩子：用于替换 chunk 中的 CSS 路径
        renderChunk (code, chunk) {
          if (!chunk.facadeModuleId?.includes('?inline&used')) { return }

          const s = new MagicString(code)
          const q = code.match(RENDER_CHUNK_RE)?.[0] || '"'
          for (const [full, url] of code.matchAll(CSS_URL_RE)) {
            if (url && resolveFromPublicAssets(url)) {
              s.replace(full, `url(${q} + publicAssetsURL(${q}${url}${q}) + ${q})`)
            }
          }

          if (s.hasChanged()) {
            s.prepend(`import { publicAssetsURL } from '#internal/nuxt/paths';`)
            return {
              code: s.toString(),
              map: options.sourcemap ? s.generateMap({ hires: true }) : undefined,
            }
          }
        },
        // 在生成 bundle（输出文件）阶段处理 .css 文件路径
        generateBundle (_outputOptions, bundle) {
          for (const [file, chunk] of Object.entries(bundle)) {
            if (!file.endsWith('.css') || chunk.type !== 'asset') { continue }

            let css = chunk.source.toString()
            let wasReplaced = false
            for (const [full, url] of css.matchAll(CSS_URL_RE)) {
              if (url && resolveFromPublicAssets(url)) {
                // 将绝对路径替换为相对路径
                const relativeURL = relative(withLeadingSlash(dirname(file)), url)
                css = css.replace(full, `url(${relativeURL})`)
                wasReplaced = true
              }
            }
            if (wasReplaced) {
              chunk.source = css
            }
          }
        },
      },
    },
  ]
})

// 匹配 URL 中的查询字符串或 hash（用于路径清理）
const PUBLIC_ASSETS_RE = /[?#].*$/

// 提供公共资源路径解析工具
export function useResolveFromPublicAssets () {
  const nitro = useNitro()

  function resolveFromPublicAssets (id: string) {
    for (const dir of nitro.options.publicAssets) {
      if (!id.startsWith(withTrailingSlash(dir.baseURL || '/'))) { continue }
      // 替换为真实的文件系统路径
      const path = id.replace(PUBLIC_ASSETS_RE, '').replace(withTrailingSlash(dir.baseURL || '/'), withTrailingSlash(dir.dir))
      if (existsSync(path)) {
        return id
      }
    }
  }

  return { resolveFromPublicAssets }
}
