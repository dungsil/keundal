<script setup lang="ts">
import { SlotOutlet } from '@keundal/ui-slots'

import { useText } from '../locale'

const { t } = useText()

const sidebarOpen = ref(false)
const mainContent = useTemplateRef('mainContent')
const removePageHook = useNuxtApp().hook('page:finish', async () => {
  sidebarOpen.value = false
  await nextTick()
  mainContent.value?.focus()
})
onUnmounted(removePageHook)

const close = () => {
  sidebarOpen.value = false
}
</script>

<template>
  <a href="#main-content" class="sr-only focus:not-sr-only focus:fixed focus:start-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-default focus:p-3" @click.prevent="mainContent?.focus()">
    {{ t('navigation.skipToContent') }}
  </a>
  <UDashboardGroup unit="rem">
    <UDashboardSidebar
      id="default"
      role="complementary"
      :aria-label="t('navigation.chats')"
      v-model:open="sidebarOpen"
      :min-size="12"
      collapsible
      resizable
      :menu="{ inset: true }"
      class="border-r-0 py-4 dark:[--ui-bg-elevated:var(--ui-color-neutral-900)]"
    >
      <template #header>
        <UDashboardSidebarCollapse class="ms-auto" />
      </template>

      <template #default="{ collapsed }">
        <SlotOutlet name="layout.sidebar" :owner="{ collapsed, close }" />
      </template>

      <template #footer="{ collapsed }">
        <div class="flex flex-col gap-1 w-full">
          <SlotOutlet name="layout.sidebar.footer" :owner="{ collapsed, close }" />
        </div>
      </template>
    </UDashboardSidebar>

    <SlotOutlet name="layout.overlay" />

    <main id="main-content" ref="mainContent" tabindex="-1" class="flex-1 flex mt-4 sm:ms-4 lg:ms-0 sm:rounded-ss-lg ring ring-default bg-default/75 shadow-sm min-w-0 overflow-hidden">
      <NuxtPage />
    </main>
  </UDashboardGroup>
</template>
