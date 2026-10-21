import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  extends: ['@keundal/ui'],
  modules: ['@nuxt/eslint', '@nuxt/ui', '@comark/nuxt', 'nuxt-charts'],
  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],
  ui: { fonts: false },
  runtimeConfig: { public: { desktop: false, agentEndpoint: '', agentToken: '' } },
  experimental: {
    viewTransition: true,
    defaults: { nuxtLink: { prefetchOn: { visibility: false, interaction: true } } }
  },
  compatibilityDate: '2026-06-30',
  vite: { optimizeDeps: { include: ['striptags'] } },
  eslint: { config: { stylistic: { commaDangle: 'never', braceStyle: '1tbs' } } }
})
