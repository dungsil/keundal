import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: [fileURLToPath(new URL('./app/assets/css/main.css', import.meta.url))],
  ui: { fonts: false },
  vite: { optimizeDeps: { include: ['striptags'] } },
  icon: {
    provider: 'none',
    clientBundle: {
      scan: { globInclude: ['**/*.{vue,ts}'] },
      icons: ['lucide:image', 'simple-icons:anthropic', 'simple-icons:google', 'simple-icons:openai']
    }
  }
})
