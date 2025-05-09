import destr from 'destr'
import { defineNuxtPlugin, useNuxtApp } from '../nuxt'

// 更新nuxt的存储在 sessionStorage 的状态

export default defineNuxtPlugin({
  name: 'nuxt:restore-state',
  hooks: {
    'app:mounted' () {
      const nuxtApp = useNuxtApp()
      try {
        const state = sessionStorage.getItem('nuxt:reload:state')
        if (state) {
          sessionStorage.removeItem('nuxt:reload:state')
          Object.assign(nuxtApp.payload.state, destr<Record<string, any>>(state)?.state)
        }
      } catch {
        // don't throw an error if we have issues reading sessionStorage
      }
    },
  },
})
