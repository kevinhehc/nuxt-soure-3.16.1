import { createDebugger } from 'hookable'
import { defineNuxtPlugin } from '../nuxt'

// 在开发环境下自动给 Nuxt App 的 hooks 系统安装调试器，方便你观察所有 hooks 的调用过程！

export default defineNuxtPlugin({
  name: 'nuxt:debug:hooks',
  enforce: 'pre',
  setup (nuxtApp) {
    createDebugger(nuxtApp.hooks, { tag: 'nuxt-app' })
  },
})
