import { getRequestURL } from 'h3'
import { useRequestEvent } from './ssr'

/** @since 3.5.0 */
// 无论在服务器端还是客户端，统一安全地获取当前请求的 URL。
export function useRequestURL (opts?: Parameters<typeof getRequestURL>[1]) {
  if (import.meta.server) {
    // 如果当前是在 服务器端（import.meta.server === true）：
    // 调用 useRequestEvent() 拿到当前请求的 RequestEvent（服务器请求上下文）。
    // 再用 getRequestURL() 生成完整 URL。
    //
    // 特点 ：
    // 服务器端没有 window.location，必须根据请求头自己拼 URL。
    // getRequestURL 会自动处理 x-forwarded-host、basePath 等反向代理情况。
    return getRequestURL(useRequestEvent()!, opts)
  }

  // 如果当前是在 客户端（浏览器环境）：
  // 直接用 window.location.href 构造一个新的 URL 对象。
  // 特点：
  // 客户端已经有浏览器原生地址，直接安全拿即可。
  return new URL(window.location.href)
}
