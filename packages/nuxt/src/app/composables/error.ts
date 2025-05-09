import type { H3Error } from 'h3'
import { createError as createH3Error } from 'h3'
import { toRef } from 'vue'
import type { Ref } from 'vue'
import { useNuxtApp } from '../nuxt'
import type { NuxtPayload } from '../nuxt'
import { useRouter } from './router'

//  error

// @ts-expect-error virtual file
import { nuxtDefaultErrorValue } from '#build/nuxt.config.mjs'

export const NUXT_ERROR_SIGNATURE = '__nuxt_error'

/** @since 3.0.0 */
export const useError = (): Ref<NuxtPayload['error']> => toRef(useNuxtApp().payload, 'error')

export interface NuxtError<DataT = unknown> extends H3Error<DataT> {
  error?: true
}

/** @since 3.0.0 */
export const showError = <DataT = unknown>(
  error: string | Error | (Partial<NuxtError<DataT>> & {
    status?: number
    statusText?: string
  }),
) => {
  const nuxtError = createError<DataT>(error)

  try {
    const nuxtApp = useNuxtApp()
    const error = useError()

    if (import.meta.client) {
      nuxtApp.hooks.callHook('app:error', nuxtError)
    }

    error.value ||= nuxtError
  } catch {
    throw nuxtError
  }

  return nuxtError
}

/** @since 3.0.0 */
export const clearError = async (options: { redirect?: string } = {}) => {
  const nuxtApp = useNuxtApp()
  const error = useError()

  nuxtApp.callHook('app:error:cleared', options)

  if (options.redirect) {
    await useRouter().replace(options.redirect)
  }

  error.value = nuxtDefaultErrorValue
}

/** @since 3.0.0 */
export const isNuxtError = <DataT = unknown>(
  error: unknown,
): error is NuxtError<DataT> => !!error && typeof error === 'object' && NUXT_ERROR_SIGNATURE in error

/** @since 3.0.0 */
export const createError = <DataT = unknown>(
  error: string | Error | (Partial<NuxtError<DataT>> & {
    status?: number
    statusText?: string
  }),
) => {
  const nuxtError: NuxtError<DataT> = createH3Error<DataT>(error)

  Object.defineProperty(nuxtError, NUXT_ERROR_SIGNATURE, {
    value: true,
    configurable: false,
    writable: false,
  })

  return nuxtError
}
