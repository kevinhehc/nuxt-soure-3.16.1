文件名	                            作用总结
client-fallback.client.ts	------ 客户端专用 fallback 组件；比如岛模式 (<NuxtIsland>) 渲染失败时的占位内容。只在浏览器执行。
client-fallback.server.ts	------ 服务端专用 fallback 组件；在服务器渲染阶段提供占位，防止 mismatch。
client-only.ts	------ <ClientOnly> 组件实现，只在客户端渲染内部内容。防止 SSR mismatch 错误。
dev-only.ts	------ <DevOnly> 组件，仅在开发环境 (process.env.NODE_ENV === 'development') 渲染，用于 devtool、debug 面板。
error-404.vue	------ 默认的 404 页面 (Not Found)，当路由没有匹配到任何页面时展示。
error-500.vue	------ 默认的 500 错误页面 (Internal Server Error)，当服务器抛出未捕获错误时展示。
error-dev.vue	------ 开发模式下的错误展示页面，带详细的 stack trace、错误提示。
index.ts	------ 统一导出整个 components 目录的组件，供外部（如 App 入口）快速导入使用。
injections.ts	------ 统一定义内部组件需要用到的 provide/inject keys，比如 Layout, AppContext 之类。
island-renderer.ts	------ 支持 Nuxt "岛架构"（Partial Hydration），管理 <NuxtIsland> 的渲染逻辑。
layout.ts	帮助 ------ <NuxtLayout> 实现的逻辑，包括动态加载布局组件，处理布局变化。
nuxt-error-boundary.ts	------ <NuxtErrorBoundary> 实现，给子组件包裹错误捕获逻辑 (try-catch)，防止整个页面崩。
nuxt-error-page.vue	------ 包装 <ErrorBoundary> 后，当错误发生时，展示友好的错误页面。
nuxt-island.ts	------ <NuxtIsland> 组件本体，负责局部刷新、分片渲染；用于岛架构优化。
nuxt-layout.ts	------ <NuxtLayout> 组件本体，动态渲染/切换不同布局（layout）用。
nuxt-link.ts	------ <NuxtLink> 组件，扩展自 <router-link>，支持 prefetch、prefetched 属性优化性能。
nuxt-loading-indicator.ts	------ <NuxtLoadingIndicator> 组件，全局 loading 动画，比如切路由时顶部的小进度条。
nuxt-root.vue	------ <NuxtRoot> 根组件，把所有 Nuxt 应用内容包裹起来（页面、布局、loading、errors 都在这层）。
nuxt-route-announcer.ts	------ 路由变化时，给 assistive technology（如屏幕阅读器）发送事件，提升无障碍访问性 (a11y)。
nuxt-stubs.ts	------ 给测试环境用的组件 Stub（占位组件），比如测试 <ClientOnly> 时用空壳子替代。
nuxt-teleport-island-component.ts	------ 用于实现 Teleport + Island 渲染结合（跨 DOM 树传送岛内容）。
nuxt-teleport-island-slot.ts	------ 配合 teleport-island-component，管理 slot 内容的 Teleport 传送和接收。
route-provider.ts	内部 ------ <RouteProvider>，把路由信息（$route 等）注入到子组件树里。
server-placeholder.ts	------ 仅服务端渲染阶段用的占位组件，客户端替换时不会 hydration mismatch。
test-component-wrapper.ts	------ 测试辅助组件，用来在测试中包裹被测试组件，模拟应用上下文环境。
utils.ts	------ 提供各种小工具函数（比如解析 query、动态导入组件等），被上述组件内部调用。
welcome.vue	------ 开发时欢迎页面（第一次安装后），如果 /pages 目录没有文件，展示欢迎提示。
