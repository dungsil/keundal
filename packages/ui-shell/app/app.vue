<script setup lang="ts">
import { SlotRoot } from '@keundal/ui-slots'
import { en, ko } from '@nuxt/ui/locale'

const { locale } = useLocale()
const uiLocale = computed(() => locale.value === 'ko' ? ko : en)
const { $ui } = useNuxtApp()
</script>

<template>
  <UApp :locale="uiLocale" :toaster="{ position: 'top-right' }" :tooltip="{ delayDuration: 200 }">
    <SlotRoot :service="$ui.slots" />
  </UApp>
</template>
