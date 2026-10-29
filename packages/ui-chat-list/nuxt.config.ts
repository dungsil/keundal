import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  hooks: {
    'pages:extend'(pages) {
      pages.push({
        name: 'history',
        path: '/history',
        file: fileURLToPath(new URL('./app/routes/history.vue', import.meta.url))
      })
    }
  }
})
