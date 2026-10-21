import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  extends: ['@keundal/ui'],
  modules: ['@nuxt/ui', '@comark/nuxt', 'nuxt-charts'],
  app: { head: { style: [{ innerHTML: 'html.dark { --startup-bg: #09090b; --startup-fg: #fafafa; }' }] } },
  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],
  ui: { fonts: false },
  spaLoadingTemplate: fileURLToPath(new URL('./app/spa-loading-template.html', import.meta.url)),
  runtimeConfig: { public: { chatCapabilities: { secureSettings: false, localSkills: false }, agentEndpoint: '', agentToken: '' } },
  experimental: {
    viewTransition: true,
    defaults: { nuxtLink: { prefetchOn: { visibility: false, interaction: true } } }
  },
  compatibilityDate: '2026-06-30',
  vite: { optimizeDeps: { include: ['striptags'] } },
  icon: {
    provider: 'none',
    clientBundle: {
      scan: { globInclude: ['**/*.{vue,ts}'] },
      icons: [
        'lucide:cloud',
        'lucide:cloud-fog',
        'lucide:cloud-rain',
        'lucide:image',
        'simple-icons:anthropic',
        'simple-icons:google',
        'simple-icons:openai'
      ]
    }
  }
})
