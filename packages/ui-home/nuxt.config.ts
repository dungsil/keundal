import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  hooks: {
    'pages:extend'(pages) {
      pages.push({ name: 'index', path: '/', file: fileURLToPath(new URL('./app/routes/index.vue', import.meta.url)) })
    }
  }
})
