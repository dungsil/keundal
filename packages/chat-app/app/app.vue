<script setup lang="ts">
import { en, ko } from '@nuxt/ui/locale'
import { greetingTimeScript } from './utils/greeting'

const { locale, t } = useLocale()
const uiLocale = computed(() => locale.value === 'ko' ? ko : en)

const colorMode = useColorMode()

const color = computed(() => colorMode.value === 'dark' ? '#1b1718' : 'white')

useHead({
  meta: [
    { charset: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { key: 'theme-color', name: 'theme-color', content: color }
  ],
  link: [
    { rel: 'icon', href: '/favicon.ico' }
  ],
  script: [
    {
      key: 'greeting-time',
      tagPriority: 'critical',
      innerHTML: greetingTimeScript
    }
  ],
  htmlAttrs: {
    lang: locale
  }
})

const title = computed(() => t('seo.title'))
const description = computed(() => t('seo.description'))

useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogImage: 'https://ui.nuxt.com/assets/templates/nuxt/chat-light.png',
  twitterCard: 'summary_large_image'
})
</script>

<template>
  <UApp :locale="uiLocale" :toaster="{ position: 'top-right' }" :tooltip="{ delayDuration: 200 }">
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
