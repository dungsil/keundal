<script setup lang="ts">
import { en, ko } from '@nuxt/ui/locale'
import { greetingTimeScript } from './utils/greeting'

const { locale, t } = useLocale()
const uiLocale = computed(() => locale.value === 'ko' ? ko : en)

const colorMode = useColorMode()
const startupReady = ref(false)
const mounted = ref(false)
const startupPending = useState<Record<string, boolean>>('startup-pending', () => ({}))
const modelSwitching = useState('model-switching', () => false)

onNuxtReady(() => {
  mounted.value = true
})

watch(
  () => mounted.value && !colorMode.unknown && !modelSwitching.value
    && !Object.values(startupPending.value).some(Boolean),
  async (ready, _, onCleanup) => {
    if (!ready || startupReady.value) return
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    await nextTick()
    // Force layout so fonts used by the hydrated first screen begin loading.
    document.body.getBoundingClientRect()
    await document.fonts.ready
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!cancelled) startupReady.value = true
  },
  { flush: 'post' }
)

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
    <StartupSplash v-if="!startupReady" />
    <div :inert="!startupReady" :aria-busy="!startupReady" style="display: contents;">
      <NuxtLoadingIndicator color="var(--ui-primary)" />

      <NuxtLayout>
        <NuxtPage />
      </NuxtLayout>
    </div>
  </UApp>
</template>
