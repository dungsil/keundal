import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  extends: ['@keundal/ui'],
  modules: ['@nuxt/eslint', '@nuxt/ui', '@comark/nuxt', 'nuxt-charts'],
  app: { head: { style: [{ innerHTML: 'html.dark { --startup-bg: #09090b; --startup-fg: #fafafa; }' }] } },
  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],
  spaLoadingTemplate: fileURLToPath(new URL('./app/spa-loading-template.html', import.meta.url)),
  runtimeConfig: { public: { desktop: false, agentEndpoint: '', agentToken: '' } },
  experimental: { viewTransition: true },
  compatibilityDate: '2026-06-30',
  vite: { optimizeDeps: { include: ['striptags'] } },
  eslint: { config: { stylistic: { commaDangle: 'never', braceStyle: '1tbs' } } },
  fonts: {
    npm: { root: fileURLToPath(new URL('.', import.meta.url)) },
    families: [
      { name: 'Pretendard', provider: 'npm', weights: [400, 500, 700], global: true, display: 'swap', preload: false }
    ]
  }
})
