import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  app: { head: { style: [{ innerHTML: 'html.dark { --startup-bg: #09090b; --startup-fg: #fafafa; }' }] } },
  spaLoadingTemplate: fileURLToPath(new URL('./app/spa-loading-template.html', import.meta.url)),
  runtimeConfig: {
    public: { chatCapabilities: { secureSettings: false, localSkills: false }, agentEndpoint: '', agentToken: '' }
  },
  experimental: {
    viewTransition: true,
    defaults: { nuxtLink: { prefetchOn: { visibility: false, interaction: true } } }
  }
})
