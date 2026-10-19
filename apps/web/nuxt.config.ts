// Nitro의 Wrangler 타입에 아직 없는 previews 설정도 생성 파일에 전달한다.
const wrangler = {
  name: 'keundal-web',
  preview_urls: false,
  previews: {}
}

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
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
    public: { desktop: false }
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

  eslint: {
    config: {
      stylistic: {
        commaDangle: 'never',
        braceStyle: '1tbs'
      }
    }
  }
})
