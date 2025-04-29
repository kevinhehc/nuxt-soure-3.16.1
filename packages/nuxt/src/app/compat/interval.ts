import { createError } from '../composables/error'

const intervalError = '[nuxt] `setInterval` should not be used on the server. Consider wrapping it with an `onNuxtReady`, `onBeforeMount` or `onMounted` lifecycle hook, or ensure you only call it in the browser by checking `import.meta.client`.'

// 定义一个常量 setInterval。
// 根据条件 import.meta.client 来决定 setInterval 的值。
// import.meta.client 是 Vite 提供的，在客户端环境是 true，在服务器端环境是 false。
export const setInterval = import.meta.client
  ? window.setInterval
  : () => {
      if (import.meta.dev) {
        // 在开发模式中，如果有人在服务器端调用 setInterval，直接抛出一个 500 错误。
        // createError 是 Nuxt 的一个内部工具，用来生成符合规范的错误对象。
        // intervalError 是一个字符串变量，通常会写着类似 "setInterval cannot be used on the server" 的信息。
        throw createError({
          statusCode: 500,
          message: intervalError,
        })
      }

      console.error(intervalError)
    }
