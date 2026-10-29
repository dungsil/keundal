<script setup lang="ts">
import type { Ref } from 'vue'
import AppFrame from './AppFrame.vue'
import StartupSplash from './StartupSplash.vue'

const { locale, t } = useLocale()
const props = defineProps<{ ready: Ref<boolean> }>()

// StartupSplash.vue의 페이드 아웃 시간과 맞춘다.
const SPLASH_FADE_MS = 200

const colorMode = useColorMode()
const startupReady = ref(false)
const splashLeaving = ref(false)
const splashGone = ref(false)
const mounted = ref(false)
let splashTimer: ReturnType<typeof setTimeout> | undefined

onNuxtReady(() => {
  mounted.value = true
})

watch(
  () => mounted.value && !colorMode.unknown && props.ready.value,
  async (ready, _, onCleanup) => {
    if (!ready || startupReady.value) return
    let cancelled = false
    onCleanup(() => {
      cancelled = true
    })
    await nextTick()
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    if (!cancelled) startupReady.value = true
  },
  { flush: 'post' }
)

watch(startupReady, (ready) => {
  if (!ready) return
  splashLeaving.value = true
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  // 전환이 끝난 뒤에 제거하려고 프레임 여유를 조금 더 둔다.
  splashTimer = setTimeout(() => {
    splashGone.value = true
  }, reducedMotion ? 0 : SPLASH_FADE_MS + 50)
})

onBeforeUnmount(() => {
  if (splashTimer) clearTimeout(splashTimer)
})

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
  twitterCard: 'summary_large_image'
})
</script>

<template>
  <StartupSplash v-if="!splashGone" :leaving="splashLeaving" />
  <div :inert="!startupReady" :aria-busy="!startupReady" style="display: contents;">
    <NuxtLoadingIndicator color="var(--ui-primary)" />

    <AppFrame />
  </div>
</template>
