import { hasProtocol } from 'ufo'
import { defineNuxtRouteMiddleware } from '../composables/router'
import { getRouteRules } from '../composables/manifest'

// 根据 route rules 自动处理页面跳转和重定向。
export default defineNuxtRouteMiddleware(async (to) => {
  // 如果是在服务器端（SSR 渲染阶段），或者在测试环境（比如 vitest 测试运行时），
  // 直接 return，不做任何跳转处理。
  // 因为 SSR 时应由服务器端 router/headers 控制，客户端才需要 redirect。
  if (import.meta.server || import.meta.test) { return }

  // 调用 getRouteRules()，根据目标路由 to.path 拉取匹配的 route rules 配置。
  // 这些 rules 可能来自：
  // nuxt.config.ts 中的 routeRules
  // nitro 自动生成的 public/_routes.json
  // 运行时更新的动态规则
  const rules = await getRouteRules({ path: to.path })

  // 如果该路由的规则中包含 redirect 字段，
  // 说明需要执行重定向处理！
  if (rules.redirect) {
    // 检查 rules.redirect 是不是一个带协议的地址（比如 https://xxx.com）或者允许的相对地址。
    if (hasProtocol(rules.redirect, { acceptRelative: true })) {
      // 直接用 window.location.href 让浏览器跳转到指定 URL。
      // 注意： 这里是硬跳转，不是 Nuxt 内部的 router.replace。
      window.location.href = rules.redirect
      // 阻止当前的 vue-router 导航继续执行。
      // 因为已经跳出页面了。
      return false
    }

    // 如果不是带协议的 URL（比如只是 /new-path），
    // 返回这个 redirect 字符串。
    // Nuxt 会理解为内部导航跳转到这个新地址。
    // 相当于：
    // router.replace(rules.redirect)
    return rules.redirect
  }
})
