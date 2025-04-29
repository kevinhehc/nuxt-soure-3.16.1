import type { Ref } from 'vue'
import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { useNuxtApp } from '../nuxt'
import { injectHead } from './head'

export type Politeness = 'assertive' | 'polite' | 'off'

export type NuxtRouteAnnouncerOpts = {
  /** @default 'polite' */
  politeness?: Politeness
}

export type RouteAnnouncer = {
  message: Ref<string>
  politeness: Ref<Politeness>
  set: (message: string, politeness: Politeness) => void
  polite: (message: string) => void
  assertive: (message: string) => void
  _cleanup: () => void
}

// 当用户页面导航（路由变化）时，自动更新屏幕阅读器（screen reader）可以朗读的新页面标题或信息。
// 特别适合 视觉障碍用户 提升网页无障碍体验！
// （也是 WAI-ARIA 标准的重要组成部分）

function createRouteAnnouncer (opts: NuxtRouteAnnouncerOpts = {}) {

  // message 是要读出来的文本内容。
  // politeness 是读出来的优先级（'polite' | 'assertive'）
  // polite（礼貌）：等当前任务结束再播报
  // assertive（强制）：立刻中断正在播报内容
  // injectHead() 可以拿到 active head manager，用于挂 DOM 更新 hook。
  // 核心：读什么？何时读？
  const message = ref('')
  const politeness = ref<Politeness>(opts.politeness || 'polite')
  const activeHead = injectHead()

  // set()：直接设置消息 + 优先级。
  // polite()：以 polite 方式设置。
  // assertive()：以 assertive 方式设置。
  // 提供方便的 API，让开发者可以随时手动改广播内容。
  function set (messageValue: string = '', politenessSetting: Politeness = 'polite') {
    message.value = messageValue
    politeness.value = politenessSetting
  }

  function polite (message: string) {
    return set(message, 'polite')
  }

  function assertive (message: string) {
    return set(message, 'assertive')
  }

  // 初始就把当前 document.title 填到 message 里。
  // 保证一上来就有内容可以播报。
  // 保证第一次加载时也有友好体验。
  function _updateMessageWithPageHeading () {
    set(document?.title?.trim(), politeness.value)
  }


  // 方便在不需要时移除 Hook，防止内存泄漏。
  function _cleanup () {
    activeHead?.hooks?.removeHook('dom:rendered', _updateMessageWithPageHeading)
  }

  // 默认初始更新一次
  _updateMessageWithPageHeading()

  // 每次 head 渲染完（比如 meta title 改变），重新拿新的 document.title 更新 message。
  // 动态响应页面 title 更新。
  activeHead?.hooks?.hook('dom:rendered', () => {
    _updateMessageWithPageHeading()
  })

  // 一个完整的 Route Announcer 控制器。
  return {
    _cleanup,
    message,
    politeness,
    set,
    polite,
    assertive,
  }
}

/**
 * composable to handle the route announcer
 * @since 3.12.0
 */
// 这是暴露给用户的 Composable Hook，真正给开发者用的！
export function useRouteAnnouncer (opts: Partial<NuxtRouteAnnouncerOpts> = {}): Omit<RouteAnnouncer, '_cleanup'> {
  const nuxtApp = useNuxtApp()

  // Initialise global route announcer if it doesn't exist already
  // 只创建一次，全局共享。
  // 如果已经有了，直接复用。
  // 提升性能，避免重复创建。
  const announcer = nuxtApp._routeAnnouncer ||= createRouteAnnouncer(opts)

  // 如果新调用时要求不同的 politeness，就动态更新。
  // 每个调用可以按需修改广播优先级。
  if (opts.politeness !== announcer.politeness.value) {
    announcer.politeness.value = opts.politeness || 'polite'
  }
  if (import.meta.client && getCurrentScope()) {
    // 每次用到时，计数器 +1
    // 当组件销毁，计数器 -1
    // 如果没人用了，自动 cleanup，释放内存。
    // 保证资源合理释放，防止内存泄漏！
    nuxtApp._routeAnnouncerDeps ||= 0
    nuxtApp._routeAnnouncerDeps++
    onScopeDispose(() => {
      nuxtApp._routeAnnouncerDeps!--
      if (nuxtApp._routeAnnouncerDeps === 0) {
        announcer._cleanup()
        delete nuxtApp._routeAnnouncer
      }
    })
  }

  return announcer
}
