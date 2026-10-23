<script setup lang="ts">
import { useText } from '../locale'

defineProps<{
  collapsed: boolean
  close: () => void
}>()

const { t } = useText()
const route = useRoute()
const isSettings = computed(() => route.path === '/settings' || route.path.startsWith('/settings/'))
</script>

<template>
  <UButton
    :label="collapsed ? '' : t('settings.title')"
    :to="{ path: isSettings ? route.path : '/settings', query: isSettings ? route.query : { returnTo: route.path } }"
    icon="i-lucide-settings-2"
    color="neutral"
    :variant="isSettings ? 'soft' : 'ghost'"
    class="w-full"
    :aria-label="t('settings.title')"
    @click="close()"
  />
</template>
