<script setup lang="ts">
import { SlotOutlet } from '@keundal/ui-slots'

import { useText } from '../locale'

const { t } = useText()

const mainContent = useTemplateRef('mainContent')
const nuxtApp = useNuxtApp()
onMounted(() => {
  // Child navigation closes its drawer before the frame restores focus.
  const removePageHook = nuxtApp.hook('page:finish', async () => {
    await nextTick()
    mainContent.value?.focus()
  })
  onUnmounted(removePageHook)
})
</script>

<template>
  <a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-default focus:p-3" @click.prevent="mainContent?.focus()">
    {{ t('navigation.skipToContent') }}
  </a>
  <UDashboardGroup unit="rem">
    <SlotOutlet name="layout.navigation" />

    <SlotOutlet name="layout.overlay" />

    <main id="main-content" ref="mainContent" tabindex="-1" class="flex-1 flex mt-4 sm:ms-4 lg:ms-0 sm:rounded-ss-lg ring ring-default bg-default/75 shadow-sm min-w-0 overflow-hidden">
      <NuxtPage />
    </main>
  </UDashboardGroup>
</template>
