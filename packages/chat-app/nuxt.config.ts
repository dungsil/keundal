import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  // UI plugins are Nuxt layers so their components compile with this application's modules and styles.
  extends: [
    '@keundal/ui',
    '@keundal/ui-markdown-comark',
    '@keundal/ui-layout',
    '@keundal/ui-chat-list',
    '@keundal/ui-home',
    '@keundal/ui-composer',
    '@keundal/ui-dictation',
    '@keundal/ui-model-selection',
    '@keundal/ui-chat',
    '@keundal/ui-trace',
    '@keundal/ui-tool',
    '@keundal/ui-chart',
    '@keundal/ui-weather',
    '@keundal/ui-settings',
    '@keundal/ui-settings-llm',
    '@keundal/ui-subagents',
    '@keundal/ui-memory',
    '@keundal/ui-skill',
    '@keundal/ui-mcp',
    '@keundal/ui-agent-plugins'
  ],
  modules: ['@nuxt/ui'],
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
        'lucide:image',
        'simple-icons:anthropic',
        'simple-icons:google',
        'simple-icons:openai'
      ]
    }
  }
})
