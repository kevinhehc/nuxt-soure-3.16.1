import { defineNuxtPlugin } from '../nuxt'

// 针对 Webpack 打包时的 模块预加载 (preload) 支持插件源码：

export default defineNuxtPlugin({
  name: 'nuxt:webpack-preload',
  setup (nuxtApp) {
    nuxtApp.vueApp.mixin({
      beforeCreate () {
        const { modules } = this.$nuxt.ssrContext
        const { __moduleIdentifier } = this.$options
        modules.add(__moduleIdentifier)
      },
    })
  },
})
