export default defineNuxtConfig({
  extends: ['@keundal/chat-app'],
  ssr: false,
  devtools: { enabled: false },
  runtimeConfig: { public: { chatCapabilities: { secureSettings: true, localSkills: true } } },
  srcDir: 'app',
  devServer: { host: '127.0.0.1', port: 1420 },
  nitro: { output: { publicDir: 'dist' } },
  vite: { server: { strictPort: true } }
})
