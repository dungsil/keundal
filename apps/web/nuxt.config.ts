// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  modules: [
    '@nuxt/eslint',
    '@nuxt/ui',
    '@comark/nuxt',
    '@nuxthub/core',
    'nuxt-auth-utils',
    'nuxt-charts',
    'nuxt-csurf'
  ],

  devtools: {
    enabled: true
  },

  css: ['~/assets/css/main.css'],

  experimental: {
    viewTransition: true
  },

  compatibilityDate: '2026-06-30',

  nitro: {
    cloudflare: {
      wrangler: {
        name: 'keundal-web'
      }
    },
    experimental: {
      openAPI: true
    }
  },

  hub: {
    db: process.env.CLOUDFLARE_D1_DATABASE_ID
      ? {
          dialect: 'sqlite',
          driver: 'd1',
          connection: { databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID }
        }
      : 'sqlite',
    blob: process.env.CLOUDFLARE_R2_BUCKET_NAME
      ? { driver: 'cloudflare-r2', binding: 'BLOB', bucketName: process.env.CLOUDFLARE_R2_BUCKET_NAME }
      : true
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
