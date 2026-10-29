import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  hooks: {
    'pages:extend'(pages) {
      pages.push({
        name: 'chat-id',
        path: '/chat/:id()',
        file: fileURLToPath(new URL('./app/routes/chat.vue', import.meta.url))
      })
    }
  }
})
