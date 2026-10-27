import { fileURLToPath } from 'node:url'

export default defineNuxtConfig({
  modules: ['@comark/nuxt'],
  css: [fileURLToPath(new URL('./app/assets/css/markdown.css', import.meta.url))]
})
