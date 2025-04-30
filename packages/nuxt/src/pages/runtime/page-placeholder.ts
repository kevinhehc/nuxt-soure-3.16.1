import { defineComponent } from 'vue'
// @ts-expect-error virtual file
// 从构建时生成的 nuxt.config.mjs 中导入开发页面目录路径（通常是 pages/）。
// #build/... 是 Nuxt 的虚拟模块，用于访问构建期生成的数据。
import { devPagesDir } from '#build/nuxt.config.mjs'

export default defineComponent({
  // 定义一个名为 NuxtPage 的组件。
  name: 'NuxtPage',
  setup (_, props) {
    if (import.meta.dev) {
      // setup 函数中，仅在开发环境下输出一个警告。
      // 提示开发者需要在 pages/ 目录下创建页面文件，否则 <NuxtPage> 组件将没有实际内容。
      // 这个警告常见于：项目还未创建 pages 目录 或 pages 功能被禁用（如使用文件路由器自定义配置时）。
      console.warn(`Create a Vue component in the \`${devPagesDir}/\` directory to enable \`<NuxtPage>\``)
    }
    // 渲染函数直接调用 default 插槽（如果有的话），相当于空壳返回。
    // 若 <NuxtPage> 被使用但未解析任何实际页面组件，就渲染这个空插槽，不报错。
    return () => props.slots.default?.()
  },
})
