import { ref } from 'vue'
import { defineNuxtPlugin } from '../nuxt'
import { useHead } from '../composables/head'

const SUPPORTED_PROTOCOLS = ['http:', 'https:']

// 用来支持浏览器的 Speculation Rules API，实现：
// 跨域预取链接，加速页面跳转体验。

export default defineNuxtPlugin({
  name: 'nuxt:cross-origin-prefetch',
  setup (nuxtApp) {
    // 创建一个 externalURLs：
    // 类型是 Vue ref 包裹的 Set<string>。
    // 用来收集所有需要进行跨域预取的外部 URL。
    // 响应式的，后面可以动态更新。
    const externalURLs = ref(new Set<string>())
    // 定义 generateRules() 函数，动态生成一段 <script type="speculationrules"> 内容。
    // 内容是：
    // source: 'list'：手动列出的 URL 列表。
    // urls：从 externalURLs 收集来的链接。
    // requires: ['anonymous-client-ip-when-cross-origin']：
    // 要求浏览器发送匿名请求（保护隐私，同时兼容跨域预取）。
    function generateRules () {
      // 最终这段 script 会插入到 HTML 里，告诉浏览器：
      // 这些链接可以预取（prefetch），提前加载！
      return {
        type: 'speculationrules',
        key: 'speculationrules',
        innerHTML: JSON.stringify({
          prefetch: [
            {
              source: 'list',
              urls: [...externalURLs.value],
              requires: ['anonymous-client-ip-when-cross-origin'],
            },
          ],
        }),
      }
    }
    // 调用 useHead() 动态注册一段 <script type="speculationrules">。
    // 一开始根据当前 externalURLs 列表生成（初始为空）。
    const head = useHead({
      script: [generateRules()],
    })
    // 监听 link:prefetch 事件。
    // 每次有新的链接被 Nuxt prefetch 机制捕获时，触发这个回调。
    nuxtApp.hook('link:prefetch', (url) => {
      // 检查这个 URL 是否是支持的协议（通常是 http:、https:）。
      // 避免非法协议或本地文件链接。
      if (SUPPORTED_PROTOCOLS.some(p => url.startsWith(p)) && SUPPORTED_PROTOCOLS.includes(new URL(url).protocol)) {
        // 把这个符合条件的新 URL 加入 externalURLs 集合。
        externalURLs.value.add(url)
        // 重新 patch 更新 head 中的 speculationrules。
        // 动态更新 <script type="speculationrules"> 内容，让浏览器知道新的可预取 URL！
        head?.patch({
          script: [generateRules()],
        })
      }
    })
  },
})
