import { defineConfig } from 'tsdown'
export default defineConfig({
  entry: [
    'src/chat-message.ts',
    'src/chat-message-publisher.ts',
    'src/llm-settings.ts',
    'src/model-preferences.ts',
    'src/skills.ts',
    'src/file.ts',
    'src/models.ts',
    'src/chat-store.ts',
    'src/platform.ts',
    'src/messages.ts',
    'src/index.ts',
    'src/tools/agent.ts',
    'src/tools/chart.ts',
    'src/tools/weather.ts'
  ],
  format: 'esm',
  fixedExtension: false,
  platform: 'browser',
  target: 'es2022',
  outDir: 'dist',
  dts: true,
  sourcemap: true,
  clean: true
})
