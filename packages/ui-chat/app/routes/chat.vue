<script setup lang="ts">
import { SlotOutlet } from '@keundal/ui-slots'

definePageMeta({
  middleware: (to, from) => {
    if (import.meta.client && to.params.id && from.params.id) to.meta.viewTransition = false
  }
})

const route = useRoute()
</script>

<template>
  <SlotOutlet name="page.chat" :owner="{ chatId: String(route.params.id) }" />
</template>
