<script setup lang="ts">
import { useText } from '../locale'

defineProps<{
  collapsed: boolean
  openSearch: () => void
}>()

const { t } = useText()
</script>

<template>
  <UNavigationMenu
    :aria-label="t('chat.actions')"
    :items="[{
      label: t('chat.new'),
      'aria-label': collapsed ? t('chat.new') : undefined,
      to: '/',
      kbds: ['meta', 'o'],
      icon: 'i-lucide-circle-plus'
    }, {
      label: t('chat.search'),
      'aria-label': collapsed ? t('chat.search') : undefined,
      icon: 'i-lucide-search',
      kbds: ['meta', 'k'],
      onSelect: () => {
        openSearch()
      }
    }, { label: t('history.title'), to: '/history', icon: 'i-lucide-history', 'aria-label': collapsed ? t('history.title') : undefined }]"
    :collapsed="collapsed"
    orientation="vertical"
  >
    <template #item-trailing="{ item }">
      <div v-if="item.kbds?.length" class="flex items-center gap-px opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
        <UKbd
          v-for="kbd in item.kbds"
          :key="kbd"
          :value="kbd"
          size="sm"
          variant="soft"
          class="bg-accented/50"
        />
      </div>
    </template>
  </UNavigationMenu>
</template>
