import type { UseScriptInput } from '@unhead/vue/scripts'
import { createError } from './error'

// 如果用户调用了某些 useScriptXXX 函数，但没有安装 @nuxt/scripts 模块，就抛出明确的错误，指导用户如何安装。
// 每一个 useScriptXXX 函数都是：
// 调用 renderStubMessage(name)
// 触发一个明确的错误
// 都加了 @typescript-eslint/no-unused-vars，避免因为参数未使用而报 lint 错误。
// 防止误用，而且不会在 SSR（服务端）阶段抛错，只在浏览器里报。

function renderStubMessage (name: string) {
  // 动态生成一条提示信息，告诉开发者：
  // 这个 API (name) 来自于 @nuxt/scripts 模块。
  // 需要安装模块才能正常使用。
  const message = `\`${name}\` is provided by @nuxt/scripts. Check your console to install it or run 'npx nuxi@latest module add @nuxt/scripts' to install it.`
  if (import.meta.client) {
    // 只有在浏览器客户端才真正抛出错误。
    // 使用 Nuxt 的 createError()，并且设置 fatal: true（致命错误，页面直接崩溃）。
    // 这样开发阶段能立刻看到错误，提示开发者去安装缺失的模块。
    throw createError({
      fatal: true,
      statusCode: 500,
      statusMessage: message,
    })
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScript<T extends Record<string | symbol, any>> (input: UseScriptInput, options?: Record<string, unknown>) {
  renderStubMessage('useScript')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptTriggerElement (...args: unknown[]) {
  renderStubMessage('useScriptTriggerElement')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptTriggerConsent (...args: unknown[]) {
  renderStubMessage('useScriptTriggerConsent')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptEventPage (...args: unknown[]) {
  renderStubMessage('useScriptEventPage')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptGoogleAnalytics (...args: unknown[]) {
  renderStubMessage('useScriptGoogleAnalytics')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptPlausibleAnalytics (...args: unknown[]) {
  renderStubMessage('useScriptPlausibleAnalytics')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptCloudflareWebAnalytics (...args: unknown[]) {
  renderStubMessage('useScriptCloudflareWebAnalytics')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptCrisp (...args: unknown[]) {
  renderStubMessage('useScriptCrisp')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptFathomAnalytics (...args: unknown[]) {
  renderStubMessage('useScriptFathomAnalytics')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptMatomoAnalytics (...args: unknown[]) {
  renderStubMessage('useScriptMatomoAnalytics')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptGoogleTagManager (...args: unknown[]) {
  renderStubMessage('useScriptGoogleTagManager')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptSegment (...args: unknown[]) {
  renderStubMessage('useScriptSegment')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptClarity (...args: unknown[]) {
  renderStubMessage('useScriptClarity')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptMetaPixel (...args: unknown[]) {
  renderStubMessage('useScriptMetaPixel')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptXPixel (...args: unknown[]) {
  renderStubMessage('useScriptXPixel')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptIntercom (...args: unknown[]) {
  renderStubMessage('useScriptIntercom')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptHotjar (...args: unknown[]) {
  renderStubMessage('useScriptHotjar')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptStripe (...args: unknown[]) {
  renderStubMessage('useScriptStripe')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptLemonSqueezy (...args: unknown[]) {
  renderStubMessage('useScriptLemonSqueezy')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptVimeoPlayer (...args: unknown[]) {
  renderStubMessage('useScriptVimeoPlayer')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptYouTubeIframe (...args: unknown[]) {
  renderStubMessage('useScriptYouTubeIframe')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptGoogleMaps (...args: unknown[]) {
  renderStubMessage('useScriptGoogleMaps')
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptNpm (...args: unknown[]) {
  renderStubMessage('useScriptNpm')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptGoogleAdsense (...args: unknown[]) {
  renderStubMessage('useScriptGoogleAdsense')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptYouTubePlayer (...args: unknown[]) {
  renderStubMessage('useScriptYouTubePlayer')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptUmamiAnalytics (...args: unknown[]) {
  renderStubMessage('useScriptUmamiAnalytics')
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function useScriptSnapchatPixel (...args: unknown[]) {
  renderStubMessage('useScriptSnapchatPixel')
}
