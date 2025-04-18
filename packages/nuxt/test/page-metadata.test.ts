import { type MockedFunction, describe, expect, it, vi } from 'vitest'
import { compileScript, parse } from '@vue/compiler-sfc'
import { klona } from 'klona'

import { PageMetaPlugin } from '../src/pages/plugins/page-meta'
import { getRouteMeta, normalizeRoutes } from '../src/pages/utils'
import type { NuxtPage } from '../schema'

const filePath = '/app/pages/index.vue'

vi.mock('klona', { spy: true })

describe('page metadata', () => {
  it('should not extract metadata from empty files', () => {
    expect(getRouteMeta('', filePath)).toEqual({})
    expect(getRouteMeta('<template><div>Hi</div></template>', filePath)).toEqual({})
  })

  it('should extract metadata from JS/JSX files', () => {
    const fileContents = `definePageMeta({ name: 'bar' })`
    for (const ext of ['js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs']) {
      const meta = getRouteMeta(fileContents, `/app/pages/index.${ext}`)
      expect(meta).toStrictEqual({
        'name': 'bar',
        'meta': {
          '__nuxt_dynamic_meta_key': new Set(['meta']),
        },
      })
    }
  })

  it('should parse JSX files', () => {
    const fileContents = `
export default {
  setup () {
    definePageMeta({ name: 'bar' })
    return () => <div></div>
  }
}
    `
    const meta = getRouteMeta(fileContents, `/app/pages/index.jsx`)
    // TODO: remove in v4
    delete meta.meta
    expect(meta).toStrictEqual({
      name: 'bar',
    })
  })

  it('should parse lang="jsx" from vue files', () => {
    const fileContents = `
  <script setup lang="jsx">
  const foo = <></>;
  definePageMeta({ name: 'bar' })
  </script>`

    const meta = getRouteMeta(fileContents, `/app/pages/index.vue`)
    expect(meta).toStrictEqual({
      'meta': {
        '__nuxt_dynamic_meta_key': new Set(['meta']),
      },
      'name': 'bar',
    })
  })

  it('should handle experimental decorators', () => {
    const fileContents = `
<script setup lang="ts">
function something (_method: () => unknown) {
  return () => 'decorated'
}
class SomeClass {
  @something
  public someMethod () {
    return 'initial'
  }
}
definePageMeta({ name: 'bar' })
</script>
    `
    const meta = getRouteMeta(fileContents, `/app/pages/index.vue`)
    expect(meta).toStrictEqual({
      'meta': {
        '__nuxt_dynamic_meta_key': new Set(['meta']),
      },
      'name': 'bar',
    })
  })

  it('should use and invalidate cache', () => {
    const _klona = klona as unknown as MockedFunction<typeof klona>
    _klona.mockImplementation(obj => obj)
    const fileContents = `<script setup>definePageMeta({ foo: 'bar' })</script>`
    const meta = getRouteMeta(fileContents, filePath)
    expect(meta === getRouteMeta(fileContents, filePath)).toBeTruthy()
    expect(meta === getRouteMeta(fileContents, '/app/pages/other.vue')).toBeFalsy()
    expect(meta === getRouteMeta('<template><div>Hi</div></template>' + fileContents, filePath)).toBeFalsy()
    _klona.mockReset()
  })

  it('should not share state between page metadata', () => {
    const fileContents = `<script setup>definePageMeta({ foo: 'bar' })</script>`
    const meta = getRouteMeta(fileContents, filePath)
    expect(meta === getRouteMeta(fileContents, filePath)).toBeFalsy()
  })

  it('should extract serialisable metadata', () => {
    const meta = getRouteMeta(`
    <script setup>
    definePageMeta({
      path: '/some-custom-path',
      validate: () => true,
      middleware: [
        function () {},
      ],
      otherValue: {
        foo: 'bar',
      },
      // 'name', 'props' and 'alias' are part of 'defaultExtractionKeys'; they're extracted from the component, so we should test the AST walking for different value types
      name: 'some-custom-name',
      props: {
        foo: 'bar',
      },
      alias: ['/alias'],
    })
    </script>
    `, filePath)

    expect(meta).toMatchInlineSnapshot(`
      {
        "alias": [
          "/alias",
        ],
        "meta": {
          "__nuxt_dynamic_meta_key": Set {
            "props",
            "meta",
          },
        },
        "name": "some-custom-name",
        "path": "/some-custom-path",
        "props": {
          "foo": "bar",
        },
      }
    `)
  })

  it('should extract serialisable metadata from files with multiple blocks', () => {
    const meta = getRouteMeta(`
    <script lang="ts">
    export default {
      name: 'thing'
    }
    </script>
    <script setup>
    definePageMeta({
      name: 'some-custom-name',
      path: '/some-custom-path',
      validate: () => true,
      middleware: [
        function () {},
      ],
      otherValue: {
        foo: 'bar',
      },
    })
    </script>
    `, filePath)

    expect(meta).toMatchInlineSnapshot(`
      {
        "meta": {
          "__nuxt_dynamic_meta_key": Set {
            "meta",
          },
        },
        "name": "some-custom-name",
        "path": "/some-custom-path",
      }
    `)
  })

  it('should extract serialisable metadata in options api', () => {
    const meta = getRouteMeta(`
    <script>
    export default {
      setup() {
        definePageMeta({
          name: 'some-custom-name',
          path: '/some-custom-path',
          middleware: (from, to) => console.warn('middleware'),
        })
      },
    };
    </script>
    `, filePath)

    expect(meta).toMatchInlineSnapshot(`
      {
        "meta": {
          "__nuxt_dynamic_meta_key": Set {
            "meta",
          },
        },
        "name": "some-custom-name",
        "path": "/some-custom-path",
      }
    `)
  })

  it('should extract serialisable metadata all quoted', () => {
    const meta = getRouteMeta(`
    <script setup>
    definePageMeta({
      "otherValue": {
        foo: 'bar',
      },
    })
    </script>
    `, filePath)

    expect(meta).toMatchInlineSnapshot(`
      {
        "meta": {
          "__nuxt_dynamic_meta_key": Set {
            "meta",
          },
        },
      }
    `)
  })

  it('should extract configured extra meta', () => {
    const meta = getRouteMeta(`
    <script setup>
    definePageMeta({
      foo: 'bar',
      bar: true,
    })
    </script>
    `, filePath, ['bar', 'foo'])

    expect(meta).toMatchInlineSnapshot(`
      {
        "bar": true,
        "foo": "bar",
      }
    `)
  })
})

describe('normalizeRoutes', () => {
  it('should produce valid route objects when used with extracted meta', () => {
    const page: NuxtPage = { path: '/', file: filePath }
    Object.assign(page, getRouteMeta(`
      <script setup>
      definePageMeta({
        name: 'some-custom-name',
        path: ref('/some-custom-path'), /* dynamic */
        validate: () => true,
        redirect: '/',
        middleware: [
          function () {},
        ],
        otherValue: {
          foo: 'bar',
        },
      })
      </script>
      `, filePath))

    page.meta ||= {}
    page.meta.layout = 'test'
    page.meta.foo = 'bar'

    const { routes, imports } = normalizeRoutes([page], new Set(), {
      clientComponentRuntime: '<client-component-runtime>',
      serverComponentRuntime: '<server-component-runtime>',
      overrideMeta: true,
    })
    expect({ routes, imports }).toMatchInlineSnapshot(`
      {
        "imports": Set {
          "import { default as indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta } from "/app/pages/index.vue?macro=true";",
        },
        "routes": "[
        {
          name: "some-custom-name",
          path: indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta?.path ?? "/",
          meta: { ...(indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta || {}), ...{"layout":"test","foo":"bar"} },
          redirect: "/",
          component: () => import("/app/pages/index.vue")
        }
      ]",
      }
    `)
  })

  it('should produce valid route objects when used without extracted meta', () => {
    const page: NuxtPage = { path: '/', file: filePath }
    page.meta ||= {}
    page.meta.layout = 'test'
    page.meta.foo = 'bar'

    const { routes, imports } = normalizeRoutes([page], new Set(), {
      clientComponentRuntime: '<client-component-runtime>',
      serverComponentRuntime: '<server-component-runtime>',
      overrideMeta: false,
    })
    expect({ routes, imports }).toMatchInlineSnapshot(`
      {
        "imports": Set {
          "import { default as indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta } from "/app/pages/index.vue?macro=true";",
        },
        "routes": "[
        {
          name: indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta?.name ?? undefined,
          path: indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta?.path ?? "/",
          props: indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta?.props ?? false,
          meta: { ...(indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta || {}), ...{"layout":"test","foo":"bar"} },
          alias: indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta?.alias || [],
          redirect: indexndqPXFtP262szLmLJV4PriPTgAg5k_457f05QyTfosBXQMeta?.redirect,
          component: () => import("/app/pages/index.vue")
        }
      ]",
      }
    `)
  })
})

describe('rewrite page meta', () => {
  const transformPlugin = PageMetaPlugin().raw({}, {} as any) as { transform: (code: string, id: string) => { code: string } | null }

  it('should extract metadata from vue components', () => {
    const sfc = `
<script setup lang="ts">
definePageMeta({
  name: 'hi',
  other: 'value'
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "const __nuxt_page_meta = {
        name: 'hi',
        other: 'value'
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should extract local functions', () => {
    const sfc = `
<script setup lang="ts">
function isNumber(value) {
  return value && !isNaN(Number(value))
}

function validateIdParam (route) {
  return isNumber(route.params.id)
}

definePageMeta({
  validate: validateIdParam,
  test: () => 'hello',
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "function isNumber(value) {
        return value && !isNaN(Number(value))
      }
      function validateIdParam (route) {
        return isNumber(route.params.id)
      }
      const __nuxt_page_meta = {
        validate: validateIdParam,
        test: () => 'hello',
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should extract user imports', () => {
    const sfc = `
<script setup lang="ts">
import { validateIdParam } from './utils'

definePageMeta({
  validate: validateIdParam,
  dynamic: ref(true),
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "import { validateIdParam } from './utils'

      const __nuxt_page_meta = {
        validate: validateIdParam,
        dynamic: ref(true),
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should not import static identifiers when shadowed in the same scope', () => {
    const sfc = `
<script setup lang="ts">
import { useState } from '#app/composables/state'

definePageMeta({
  middleware: () => {
    const useState = (key) => ({ value: { isLoggedIn: false } })
    const auth = useState('auth')
    if (!auth.value.isLoggedIn) {
      return navigateTo('/login')
    }
  },
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "const __nuxt_page_meta = {
        middleware: () => {
          const useState = (key) => ({ value: { isLoggedIn: false } })
          const auth = useState('auth')
          if (!auth.value.isLoggedIn) {
            return navigateTo('/login')
          }
        },
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should not import static identifiers when shadowed in parent scope', () => {
    const sfc = `
<script setup lang="ts">
import { useState } from '#app/composables/state'

definePageMeta({
  middleware: () => {
    function isLoggedIn() {
      const auth = useState('auth')
      return auth.value.isLoggedIn
    }

    const useState = (key) => ({ value: { isLoggedIn: false } })
    if (!isLoggedIn()) {
      return navigateTo('/login')
    }
  },
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "const __nuxt_page_meta = {
        middleware: () => {
          function isLoggedIn() {
            const auth = useState('auth')
            return auth.value.isLoggedIn
          }

          const useState = (key) => ({ value: { isLoggedIn: false } })
          if (!isLoggedIn()) {
            return navigateTo('/login')
          }
        },
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should import static identifiers when a shadowed and a non-shadowed one is used', () => {
    const sfc = `
<script setup lang="ts">
import { useState } from '#app/composables/state'

definePageMeta({
  middleware: [
    () => {
      const useState = (key) => ({ value: { isLoggedIn: false } })
      const auth = useState('auth')
      if (!auth.value.isLoggedIn) {
        return navigateTo('/login')
      }
    },
    () => {
      const auth = useState('auth')
      if (!auth.value.isLoggedIn) {
        return navigateTo('/login')
      }
    }
  ]
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "import { useState } from '#app/composables/state'

      const __nuxt_page_meta = {
        middleware: [
          () => {
            const useState = (key) => ({ value: { isLoggedIn: false } })
            const auth = useState('auth')
            if (!auth.value.isLoggedIn) {
              return navigateTo('/login')
            }
          },
          () => {
            const auth = useState('auth')
            if (!auth.value.isLoggedIn) {
              return navigateTo('/login')
            }
          }
        ]
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should import static identifiers when a shadowed and a non-shadowed one is used in the same scope', () => {
    const sfc = `
<script setup lang="ts">
import { useState } from '#app/composables/state'

definePageMeta({
  middleware: () => {
    const auth1 = useState('auth')
    const useState = (key) => ({ value: { isLoggedIn: false } })
    const auth2 = useState('auth')
    if (!auth1.value.isLoggedIn || !auth2.value.isLoggedIn) {
      return navigateTo('/login')
    }
  },
})
</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "import { useState } from '#app/composables/state'

      const __nuxt_page_meta = {
        middleware: () => {
          const auth1 = useState('auth')
          const useState = (key) => ({ value: { isLoggedIn: false } })
          const auth2 = useState('auth')
          if (!auth1.value.isLoggedIn || !auth2.value.isLoggedIn) {
            return navigateTo('/login')
          }
        },
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should work when keeping names = true', () => {
    const sfc = `
<script setup lang="ts">
import { foo } from './utils'

const checkNum = (value) => {
  return !isNaN(Number(foo(value)))
}

function isNumber (value) {
  return value && checkNum(value)
}

definePageMeta({
  validate: ({ params }) => {
    return isNumber(params.id)
  },
})
</script>
      `
    const compiled = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(compiled.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "import { foo } from './utils'
      const checkNum = (value) => {
        return !isNaN(Number(foo(value)))
      }
      function isNumber (value) {
        return value && checkNum(value)
      }
      const __nuxt_page_meta = {
        validate: ({ params }) => {
          return isNumber(params.id)
        },
      }
      export default __nuxt_page_meta"
    `)
  })

  it('should throw for await expressions', () => {
    const sfc = `
<script setup lang="ts">
const asyncValue = await Promise.resolve('test')

definePageMeta({
  key: asyncValue,
})
</script>
      `
    const compiled = compileScript(parse(sfc).descriptor, { id: 'component.vue' })

    let wasErrorThrown = false

    try {
      transformPlugin.transform(compiled.content, 'component.vue?macro=true')
    } catch (e) {
      if (e instanceof Error) {
        expect(e.message).toMatch(/await in definePageMeta/)
        wasErrorThrown = true
      }
    }

    expect(wasErrorThrown).toBe(true)
  })

  it('should only add definitions for reference identifiers', () => {
    const sfc = `
<script setup lang="ts">
const foo = 'foo'
const bar = { bar: 'bar' }.bar, baz = { baz: 'baz' }.baz, x = { foo }
const test = 'test'
const prop = 'prop'
const num = 1

const val = 'val'

const useVal = () => ({ val: 'val' })

function recursive () {
  recursive()
}

const route = useRoute()

definePageMeta({
  middleware: [
    () => {
      console.log(bar, baz)
      recursive()

      const val = useVal().val
      const obj = {
        num,
        prop: 'prop',
      }

      const c = class test {
        prop = 'prop'
        test () {}
      }

      const someFunction = () => {
        const someValue = 'someValue'
        console.log(someValue)
      }

      console.log(hoisted.value, val)
    },
  ],
  validate: (route) => {
    return route.params.id === 'test'
  }
})

// the order of a ref relative to the 'definePageMeta' call should be preserved (in contrast to a simple const)
// this tests whether the extraction handles all variables in the upper scope
const hoisted = ref('hoisted')

</script>
      `
    const res = compileScript(parse(sfc).descriptor, { id: 'component.vue' })
    expect(transformPlugin.transform(res.content, 'component.vue?macro=true')?.code).toMatchInlineSnapshot(`
      "const foo = 'foo'
      const num = 1
      const bar = { bar: 'bar' }.bar, baz = { baz: 'baz' }.baz, x = { foo }
      const useVal = () => ({ val: 'val' })
      function recursive () {
        recursive()
      }
      const hoisted = ref('hoisted')
      const __nuxt_page_meta = {
        middleware: [
          () => {
            console.log(bar, baz)
            recursive()

            const val = useVal().val
            const obj = {
              num,
              prop: 'prop',
            }

            const c = class test {
              prop = 'prop'
              test () {}
            }

            const someFunction = () => {
              const someValue = 'someValue'
              console.log(someValue)
            }

            console.log(hoisted.value, val)
          },
        ],
        validate: (route) => {
          return route.params.id === 'test'
        }
      }
      export default __nuxt_page_meta"
    `)
  })
})
