import { createWebPlatform } from '../platform'

export default defineNuxtPlugin({
  name: 'chat-platform', enforce: 'pre',
  setup() { return { provide: { chatPlatform: createWebPlatform(localStorage, useRuntimeConfig().public) } } }
})
