import { invoke } from '@tauri-apps/api/core'
import { createDesktopPlatform } from '../platform'

export default defineNuxtPlugin({
  name: 'chat-platform', enforce: 'pre',
  setup() { return { provide: { chatPlatform: createDesktopPlatform(localStorage, invoke) } } }
})
