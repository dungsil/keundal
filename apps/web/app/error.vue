<script setup lang="ts">
import type { NuxtError } from '#app'
import { en, ko } from '@nuxt/ui/locale'

const { locale, t } = useLocale()
const uiLocale = computed(() => locale.value === 'ko' ? ko : en)

defineProps<{
  error: NuxtError
}>()

useSeoMeta({
  title: () => t('error.notFound'),
  description: () => t('error.notFoundDescription')
})

useHead({
  htmlAttrs: {
    lang: locale
  }
})
</script>

<template>
  <UApp :locale="uiLocale">
    <UError :error="error.statusCode === 404 ? { ...error, statusMessage: t('error.notFound'), message: t('error.notFoundDescription') } : error" />
  </UApp>
</template>
