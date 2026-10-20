import { fileURLToPath } from 'node:url'

// Nitro의 Wrangler 타입에 아직 없는 previews 설정도 생성 파일에 전달한다.
const wrangler = {
  name: 'keundal-web',
  preview_urls: true,
  previews: {}
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  extends: ['@keundal/ui'],
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@comark/nuxt',
    'nuxt-charts'
  ],

  $env: {
    desktop: {
      ssr: false,
      buildDir: '.nuxt-desktop',
      devtools: { enabled: false },
      runtimeConfig: { public: { desktop: true } },
      devServer: { host: '127.0.0.1', port: 1420 },
      vite: { server: { strictPort: true } },
      nitro: {
        output: {
          dir: '.output-desktop',
          publicDir: '../desktop/dist'
        }
      }
    }
  },

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  ui: {
    fonts: false
  },

  runtimeConfig: {
    public: {
      desktop: false,
      // Keundal HTTP 호스트를 직접 사용할 때 지정합니다. 비어 있으면 브라우저 모드입니다.
      agentEndpoint: '',
      agentToken: ''
    }
  },
  alias: {
    '#agent-host-runtime': fileURLToPath(new URL('./server/agent/runtime-node.ts', import.meta.url))
  },

  features: {
    inlineStyles: true
  },

  experimental: {
    viewTransition: true
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    externals: {
      // pnpm 저장소의 Zod locale 경로가 서버 번들 밖으로 남지 않게 합니다.
      inline: ['zod']
    },
    cloudflare: {
      nodeCompat: true,
      deployConfig: true,
      wrangler
    },
    experimental: {
      openAPI: true
    }
  },

  vite: {
    optimizeDeps: {
      include: ['striptags']
    }
  },
  hooks: {
    'nitro:config'(config) {
      if (String(config.preset ?? '').startsWith('cloudflare')) {
        config.alias ??= {}
        config.alias['#agent-host-runtime'] = fileURLToPath(new URL('./server/agent/runtime-unavailable.ts', import.meta.url))
      }
    }
  },

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
