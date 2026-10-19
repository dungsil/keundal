// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@comark/nuxt',
    'nuxt-auth-utils',
    'nuxt-charts'
  ],

  $env: {
    desktop: {
      ssr: false,
      buildDir: '.nuxt-desktop',
      devtools: { enabled: false },
      auth: { loadStrategy: 'none' },
      runtimeConfig: { public: { desktop: true } },
      devServer: { host: '127.0.0.1', port: 1420 },
      vite: { server: { strictPort: true } },
      nitro: {
        output: { publicDir: '../desktop/dist' }
      }
    }
  },

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  runtimeConfig: {
    public: { desktop: false }
  },

  experimental: {
    viewTransition: true
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    cloudflare: {
      nodeCompat: true,
      deployConfig: true,
      wrangler: {
        name: 'keundal-web'
      }
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
