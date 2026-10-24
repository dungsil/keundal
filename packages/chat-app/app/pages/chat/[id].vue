<script setup lang="ts">
import { SlotOutlet } from '@keundal/ui-slots'

const route = useRoute()
</script>

<template>
  <SlotOutlet name="page.chat" :owner="{ chatId: String(route.params.id) }" />
</template>
