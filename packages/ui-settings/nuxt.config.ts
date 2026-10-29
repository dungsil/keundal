import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  hooks: {
    'pages:extend'(pages) {
      pages.push({
        name: 'settings-section',
        path: '/settings/:section?',
        file: fileURLToPath(new URL('./app/routes/settings.vue', import.meta.url))
      })
    }
  }
})
