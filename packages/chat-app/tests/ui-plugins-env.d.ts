// Plain tsc checks the manager tests; Nuxt's separate vue-tsc pass checks the actual SFC implementations.
declare module '*.vue' {
  const component: import('vue').Component
  export default component
}

// The static catalog's locale helpers use Nuxt auto-imports, which are absent from the Node test environment.
declare const useCookie: typeof import('nuxt/app').useCookie
declare const useState: typeof import('nuxt/app').useState
declare const useRequestHeaders: typeof import('nuxt/app').useRequestHeaders
declare const computed: typeof import('vue').computed
declare const readonly: typeof import('vue').readonly
