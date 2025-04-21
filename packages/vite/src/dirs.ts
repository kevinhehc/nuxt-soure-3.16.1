import { fileURLToPath } from 'node:url'
import { dirname } from 'pathe' // 从 'pathe' 模块导入 dirname，用于获取路径的目录名（类似于 Node.js 的 path.dirname，但兼容性更好）

// 将当前模块（当前文件）的 URL 转换为路径，再获取其所在目录名
let _distDir = dirname(fileURLToPath(import.meta.url))
// 举例：如果当前文件路径为 'file:///project/.nuxt/dist/chunks/index.js'
// 经过 fileURLToPath 会变为 '/project/.nuxt/dist/chunks/index.js'
// 然后 dirname 变成 '/project/.nuxt/dist/chunks'


// 检查目录名是否以 'chunks' 或 'shared' 结尾，如果是，则向上再取一层目录
if (_distDir.match(/(chunks|shared)$/)) { _distDir = dirname(_distDir) }
// 例如：如果是 '/project/.nuxt/dist/chunks'，则最终变为 '/project/.nuxt/dist'

// 将处理后的目录名作为 distDir 导出供其他模块使用
export const distDir = _distDir
