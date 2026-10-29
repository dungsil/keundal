<script setup lang="ts">
import { SlotOutlet } from '@keundal/ui-slots'
import { useText } from '../locale'

const { t } = useText()
const sidebarOpen = ref(false)
const close = () => {
  sidebarOpen.value = false
}
const removePageHook = useNuxtApp().hook('page:finish', close)
onUnmounted(removePageHook)
</script>

<template>
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
      <UDashboardSidebarCollapse />
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
</template>
