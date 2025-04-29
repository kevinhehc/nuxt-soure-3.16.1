import { defineNuxtPlugin } from '../nuxt'
import { onNuxtReady } from '../composables/ready'
import { useRouter } from '../composables/router'

// 优化导航性能，降低页面切换时的 INP (Interaction to Next Paint) 指标！

export default defineNuxtPlugin(() => {
  const router = useRouter()
  onNuxtReady(() => {
    router.beforeResolve(async () => {
      /**
       * This gives an opportunity for the browser to repaint, acknowledging user interaction.
       * It can reduce INP when navigating on prerendered routes.
       *
       * @see https://github.com/nuxt/nuxt/issues/26271#issuecomment-2178582037
       * @see https://vercel.com/blog/demystifying-inp-new-tools-and-actionable-insights
       */
      // 给浏览器一个机会中断当前 JavaScript 任务，去做一次渲染（Repaint）。
      await new Promise((resolve) => {
        // Ensure we always resolve, even if the animation frame never fires
        // 如果 requestAnimationFrame 的方法失效，保证最多100ms超时后 resolve。
        setTimeout(resolve, 100)
        // 请求下一帧。
        // 然后在下一帧开始后 setTimeout(0)，进一步让出执行栈。
        // 让浏览器强制有机会渲染一帧。
        requestAnimationFrame(() => { setTimeout(resolve, 0) })
      })
    })
  })
})

// 用户点击后，如果 JS 任务阻塞太久，浏览器不会立刻反馈交互（比如不会立刻变成 active 状态、点亮按钮）。
// 导致 INP（Interaction to Next Paint）指标变差。
// INP 是 Core Web Vitals 新标准，衡量用户交互的响应性。

// 插入这个小的 "休息机会"：
// 让浏览器优先画一帧（反馈点击效果），
// 然后再继续执行页面跳转，
// 提升 perceived responsiveness（感知响应性）！
