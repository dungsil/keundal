<script setup lang="ts">
import { useMounted } from '@vueuse/core'

import { useText } from '../locale'

const props = defineProps<{
  collapsed: boolean
  close(): void
  available: () => boolean
}>()

const { t } = useText()
const mounted = useMounted()
// 플랫폼은 브라우저에서만 있으므로 마운트 전에는 항목을 숨깁니다.
const show = computed(() => mounted.value && props.available())
</script>

<template>
  <NuxtLink
    v-if="show"
    to="/library"
    class="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-elevated"
    @click="close"
  >
    <UIcon name="i-lucide-film" class="size-4 shrink-0" />
    <span v-if="!collapsed">{{ t('media.title') }}</span>
  </NuxtLink>
</template>
