import { toRef, watch } from 'vue'

import { useState } from './state'
import { refreshNuxtData } from './asyncData'
import { useRoute, useRouter } from './router'

// 让页面进入预览状态，通常用于内容管理系统（CMS）联动，比如：还未发布的文章预览、草稿数据查看等。
// 它不仅支持启用/禁用预览状态，还能带上动态 state（比如 token）！

interface Preview {
  enabled: boolean
  state: Record<any, unknown>
  _initialized?: boolean
}

/**
 * Options for configuring preview mode.
 */
interface PreviewModeOptions<S> {
  /**
   * A function that determines whether preview mode should be enabled based on the current state.
   * @param {Record<any, unknown>} state - The state of the preview.
   * @returns {boolean} A boolean indicating whether the preview mode is enabled.
   */
  shouldEnable?: (state: Preview['state']) => boolean
  /**
   * A function that retrieves the current state.
   * The `getState` function will append returned values to current state, so be careful not to accidentally overwrite important state.
   * @param {Record<any, unknown>} state - The preview state.
   * @returns {Record<any, unknown>} The preview state.
   */
  getState?: (state: Preview['state']) => S
  /**
   * A function to be called when the preview mode is enabled.
   */
  onEnable?: () => void
  /**
   * A function to be called when the preview mode is disabled.
   */
  onDisable?: () => void
}

type EnteredState = Record<any, unknown> | null | undefined | void

let unregisterRefreshHook: (() => any) | undefined

/** @since 3.11.0 */
// 泛型参数 <S> 是传入的状态类型（可选）。
// options 是配置对象，允许自定义预览状态的启用/禁用逻辑。
export function usePreviewMode<S extends EnteredState> (options: PreviewModeOptions<S> = {}) {
  // 使用 useState 创建或拿到一个全局共享的 preview 状态。
  // preview 结构：
  // enabled: 是否启用了 preview mode
  // state: 任意携带的数据，比如 token 等信息。
  // 整个 app 都可以访问到 preview 状态。
  const preview = useState<Preview>('_preview-state', () => ({
    enabled: false,
    state: {},
  }))

  // 如果已经初始化（防止重复 setup）：
  // 直接返回 enabled 和 state 的引用。
  // 提高效率，避免重复监听。
  if (preview.value._initialized) {
    return {
      enabled: toRef(preview.value, 'enabled'),
      state: preview.value.state as S extends void ? Preview['state'] : (NonNullable<S> & Preview['state']),
    }
  }

  // 在客户端标记为已初始化
  if (import.meta.client) {
    preview.value._initialized = true
  }

  // 如果还没启用 preview：
  // 调用 shouldEnable 判断是否应该启用。
  // 默认逻辑：检查 URL query 里有没有 preview=true。
  // 支持自定义启用规则！
  if (!preview.value.enabled) {
    const shouldEnable = options.shouldEnable ?? defaultShouldEnable
    const result = shouldEnable(preview.value.state)

    if (typeof result === 'boolean') { preview.value.enabled = result }
  }

  // 如果启用：
  // 调用 getState（默认从 URL 中拿 token）。
  // 更新 state。
  // 在启用预览时同步带上必要的动态数据，比如鉴权 token。
  watch(() => preview.value.enabled, (value) => {
    if (value) {
      const getState = options.getState ?? getDefaultState
      const newState = getState(preview.value.state)

      if (newState !== preview.value.state) {
        Object.assign(preview.value.state, newState)
      }

      if (import.meta.client && !unregisterRefreshHook) {
        // 在客户端启用时：
        // 执行 onEnable（默认刷新 asyncData）
        // 注册一个 afterEach 钩子，在路由跳转后重新 refreshNuxtData
        // 保存 unregister 函数。
        // 保证 跳转页面后仍然正确维持预览状态！
        const onEnable = options.onEnable ?? refreshNuxtData
        onEnable()

        unregisterRefreshHook = options.onDisable ?? useRouter().afterEach(() => refreshNuxtData())
      }
    } else if (unregisterRefreshHook) {
      // 如果禁用了 preview，解除路由监听。
      // 及时清理副作用。
      unregisterRefreshHook()

      unregisterRefreshHook = undefined
    }
  }, { immediate: true, flush: 'sync' })

  return {
    // 返回响应式 enabled 和 state。
    // 页面和组件可以直接响应式使用预览状态。
    enabled: toRef(preview.value, 'enabled'),
    state: preview.value.state as S extends void ? Preview['state'] : (NonNullable<S> & Preview['state']),
  }
}

function defaultShouldEnable () {
  const route = useRoute()
  const previewQueryName = 'preview'

  return route.query[previewQueryName] === 'true'
}

function getDefaultState (state: Preview['state']) {
  if (state.token !== undefined) {
    return state
  }

  const route = useRoute()

  state.token = Array.isArray(route.query.token) ? route.query.token[0] : route.query.token

  return state
}
