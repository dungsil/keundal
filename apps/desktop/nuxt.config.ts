export default defineNuxtConfig({
  extends: [
    '@keundal/ui', '@keundal/ui-shell', '@keundal/ui-sidebar',
    '@keundal/ui-markdown-comark', '@keundal/ui-chat-list', '@keundal/ui-home',
    '@keundal/ui-composer', '@keundal/ui-dictation', '@keundal/ui-model-selection',
    '@keundal/ui-chat', '@keundal/ui-trace', '@keundal/ui-acp', '@keundal/ui-tool',
    '@keundal/ui-chart', '@keundal/ui-weather', '@keundal/ui-workspace',
    '@keundal/ui-settings', '@keundal/ui-settings-llm', '@keundal/ui-subagents',
    '@keundal/ui-memory', '@keundal/ui-automation', '@keundal/ui-skill',
    '@keundal/ui-mcp', '@keundal/ui-agent-plugins'
  ],
  pages: true,
  compatibilityDate: '2026-06-30',
  ssr: false,
  devtools: { enabled: false },
  runtimeConfig: { public: { chatCapabilities: { secureSettings: true, localSkills: true } } },
  srcDir: 'app',
  devServer: { host: '127.0.0.1', port: 1420 },
  nitro: { output: { publicDir: 'dist' } },
  vite: { server: { strictPort: true } }
})
