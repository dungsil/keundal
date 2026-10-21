import { fileURLToPath } from 'node:url'

// Nitro의 Wrangler 타입에 아직 없는 previews 설정도 생성 파일에 전달한다.
const wrangler = { name: 'keundal-web', preview_urls: true, previews: {} }

export default defineNuxtConfig({
  extends: ['@keundal/chat-app'],
  devtools: { enabled: true },
  alias: {
    '#agent-host-runtime': fileURLToPath(new URL('./server/agent/runtime-node.ts', import.meta.url))
  },
  features: { inlineStyles: false },
  nitro: {
    compressPublicAssets: true,
    externals: { inline: ['zod'] },
    cloudflare: { nodeCompat: true, deployConfig: true, wrangler },
    experimental: { openAPI: true }
  },
  hooks: {
    'build:manifest'(manifest) {
      // Load optional provider SDKs through their dynamic imports when needed.
      for (const entry of Object.values(manifest)) {
        entry.prefetch = false
        // 나머지 모듈보다 스타일시트와 글꼴을 먼저 불러온다.
        if (entry.resourceType === 'script' && !entry.isEntry) entry.preload = false
      }
    },
    'nitro:config'(config) {
      if (String(config.preset ?? '').startsWith('cloudflare')) {
        config.alias ??= {}
        config.alias['#agent-host-runtime'] = fileURLToPath(new URL('./server/agent/runtime-unavailable.ts', import.meta.url))
      }
    }
  }
})
