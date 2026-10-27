<script setup lang="ts">
import { useText } from '../locale'

const props = defineProps<{
  collapsed: boolean
  close(): void
  available: () => Promise<boolean>
}>()

const { t } = useText()
const show = ref(false)
onMounted(async () => { show.value = await props.available() })
</script>

<template>
  <NuxtLink
    v-if="show"
    to="/library"
    :aria-label="t('media.title')"
    class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
    @click="close"
  >
    <UIcon name="i-lucide-film" class="size-4 shrink-0" />
    <span v-if="!collapsed">{{ t('media.title') }}</span>
  </NuxtLink>
</template>
