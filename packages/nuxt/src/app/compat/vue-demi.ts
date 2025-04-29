export * from './capi'

// 定义并导出一个常量 Vue2，值是 undefined。
// 这个名字叫 Vue2，但实际上没有任何值（是 undefined），意思是：
// 在 Nuxt 3 中，不支持 Vue 2。
// （如果是某些兼容模式，比如 Nuxt Bridge，可能会真正给 Vue2 赋值）
export const Vue2 = undefined
export const isVue2 = false
export const isVue3 = true
