import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import type { Ref } from 'vue'
import { useNuxtApp } from '../nuxt'

export type LoadingIndicatorOpts = {
  /** @default 2000 */
  duration: number
  /** @default 200 */
  throttle: number
  /** @default 500 */
  hideDelay: number
  /** @default 400 */
  resetDelay: number
  /**
   * You can provide a custom function to customize the progress estimation,
   * which is a function that receives the duration of the loading bar (above)
   * and the elapsed time. It should return a value between 0 and 100.
   */
  estimatedProgress?: (duration: number, elapsed: number) => number
}

export type LoadingIndicator = {
  _cleanup: () => void
  progress: Ref<number>
  isLoading: Ref<boolean>
  error: Ref<boolean>
  start: (opts?: { force?: boolean }) => void
  set: (value: number, opts?: { force?: boolean }) => void
  finish: (opts?: { force?: boolean, error?: boolean }) => void
  clear: () => void
}

// 根据设定的总时长 (duration) 和已过去时间 (elapsed)，估算一个非线性增长的进度条百分比。
// 而且它用的是反正切函数 atan 来模拟真实用户感知的"越来越慢接近完成"的感觉。
// duration: 总时长，比如预计10秒完成。
// elapsed: 已过去的时间，比如已经过了4秒。
function defaultEstimatedProgress (duration: number, elapsed: number): number {
  // 先算出线性完成比例。
  // 比如：
  // duration = 10秒
  // elapsed = 4秒
  // completionPercentage = 4 / 10 * 100 = 40%
  const completionPercentage = elapsed / duration * 100
  // Math.atan() 是反正切函数（反三角函数），
  return (2 / Math.PI * 100) * Math.atan(completionPercentage / 50)

  // 时间过去的比例	线性增长百分比	atan 调整后百分比	      感知效果
  // 10%	        10%	          大概 12%	              增长稍快
  // 50%	        50%	          大概 60%	              增长明显
  // 90%	        90%	          大概 85%	              增长变慢
  // 100%	        100%	        90%+（接近但不到100）	  收敛接近完成
}

function createLoadingIndicator (opts: Partial<LoadingIndicatorOpts> = {}) {
  const { duration = 2000, throttle = 200, hideDelay = 500, resetDelay = 400 } = opts
  const getProgress = opts.estimatedProgress || defaultEstimatedProgress
  const nuxtApp = useNuxtApp()
  const progress = ref(0)
  const isLoading = ref(false)
  const error = ref(false)
  let done = false
  let rafId: number

  let throttleTimeout: number | NodeJS.Timeout
  let hideTimeout: number | NodeJS.Timeout
  let resetTimeout: number | NodeJS.Timeout

  const start = (opts: { force?: boolean } = {}) => {
    error.value = false
    set(0, opts)
  }

  function set (at = 0, opts: { force?: boolean } = {}) {
    if (nuxtApp.isHydrating) {
      return
    }
    if (at >= 100) { return finish({ force: opts.force }) }
    clear()
    progress.value = at < 0 ? 0 : at
    const throttleTime = opts.force ? 0 : throttle
    if (throttleTime && import.meta.client) {
      throttleTimeout = setTimeout(() => {
        isLoading.value = true
        _startProgress()
      }, throttleTime)
    } else {
      isLoading.value = true
      _startProgress()
    }
  }

  function _hide () {
    if (import.meta.client) {
      hideTimeout = setTimeout(() => {
        isLoading.value = false
        resetTimeout = setTimeout(() => { progress.value = 0 }, resetDelay)
      }, hideDelay)
    }
  }

  function finish (opts: { force?: boolean, error?: boolean } = {}) {
    progress.value = 100
    done = true
    clear()
    _clearTimeouts()
    if (opts.error) {
      error.value = true
    }
    if (opts.force) {
      progress.value = 0
      isLoading.value = false
    } else {
      _hide()
    }
  }

  function _clearTimeouts () {
    if (import.meta.client) {
      clearTimeout(hideTimeout)
      clearTimeout(resetTimeout)
    }
  }

  function clear () {
    if (import.meta.client) {
      clearTimeout(throttleTimeout)
      cancelAnimationFrame(rafId)
    }
  }

  function _startProgress () {
    done = false
    let startTimeStamp: number

    function step (timeStamp: number): void {
      if (done) { return }

      startTimeStamp ??= timeStamp
      const elapsed = timeStamp - startTimeStamp
      progress.value = Math.max(0, Math.min(100, getProgress(duration, elapsed)))
      if (import.meta.client) {
        rafId = requestAnimationFrame(step)
      }
    }

    if (import.meta.client) {
      rafId = requestAnimationFrame(step)
    }
  }

  let _cleanup = () => {}
  if (import.meta.client) {
    const unsubLoadingStartHook = nuxtApp.hook('page:loading:start', () => {
      start()
    })
    const unsubLoadingFinishHook = nuxtApp.hook('page:loading:end', () => {
      finish()
    })
    const unsubError = nuxtApp.hook('vue:error', () => finish())

    _cleanup = () => {
      unsubError()
      unsubLoadingStartHook()
      unsubLoadingFinishHook()
      clear()
    }
  }

  return {
    _cleanup,
    progress: computed(() => progress.value),
    isLoading: computed(() => isLoading.value),
    error: computed(() => error.value),
    start,
    set,
    finish,
    clear,
  }
}

/**
 * composable to handle the loading state of the page
 * @since 3.9.0
 */
// 页面级 loading 动画统一管理
// 组合式依赖自动清理
// 避免多次创建和资源泄露
export function useLoadingIndicator (opts: Partial<LoadingIndicatorOpts> = {}): Omit<LoadingIndicator, '_cleanup'> {
  const nuxtApp = useNuxtApp()

  // Initialise global loading indicator if it doesn't exist already
  // 如果 nuxtApp._loadingIndicator 已经存在，则复用它。
  // 否则调用 createLoadingIndicator(opts) 创建一个新的 Loading 控制器。
  // 保证 全局只创建一个 loading indicator！
  const indicator = nuxtApp._loadingIndicator ||= createLoadingIndicator(opts)
  // 只有在 客户端 + 响应式作用域 (比如组件/组合式内) 才执行后续逻辑。
  // 服务端 SSR 阶段不需要 loading 动画。
  if (import.meta.client && getCurrentScope()) {

    // 初始化 _loadingIndicatorDeps 依赖计数器。
    // 每次调用 useLoadingIndicator，计数加一。
    // 跟踪到底有多少地方正在依赖这个 loading indicator。
    nuxtApp._loadingIndicatorDeps ||= 0
    nuxtApp._loadingIndicatorDeps++

    // 注册 onScopeDispose 回调。
    // 当当前作用域（比如组件卸载）销毁时：
    // 计数器减一。
    // 如果依赖数降到 0：
    // 调用 indicator._cleanup() 彻底清理 loading indicator。
    // 删除 nuxtApp._loadingIndicator，释放内存。
    // 自动资源管理，无需手动清除！
    onScopeDispose(() => {
      nuxtApp._loadingIndicatorDeps!--
      if (nuxtApp._loadingIndicatorDeps === 0) {
        indicator._cleanup()
        delete nuxtApp._loadingIndicator
      }
    })
  }

  // 返回这个 loading 控制器对象给调用者。
  // 调用者可以用它来控制 loading 状态，比如：
  // indicator.start()
  // indicator.finish()
  // indicator.error()
  // indicator.update(progress)
  // 统一用一个全局 loading indicator，同时支持多处调用，且有作用域感知的自动清理。
  return indicator
}
