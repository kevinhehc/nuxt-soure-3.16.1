import type { SchemaDefinition } from '@nuxt/schema'
import { useNuxt } from '../context'

// 用来在 Nuxt 项目启动期间，动态扩展 Nuxt 的配置 Schema 校验规则。
export function extendNuxtSchema (def: SchemaDefinition | (() => SchemaDefinition)) {
  const nuxt = useNuxt()
  nuxt.hook('schema:extend', (schemas) => {
    schemas.push(typeof def === 'function' ? def() : def)
  })
}
