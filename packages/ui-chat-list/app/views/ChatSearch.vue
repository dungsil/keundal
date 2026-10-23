<script setup lang="ts">
import type { ChatSummary } from '@keundal/ui-runtime'
import type { Ref } from 'vue'

import { useChatGroups } from '../lib/useChatGroups'
import { useText } from '../locale'

const props = defineProps<{
  chats: Ref<ChatSummary[] | undefined>
  search: { open: boolean }
  setSearchOpen: (open: boolean) => void
}>()

const { t } = useText()

const { groups } = useChatGroups(() => props.chats.value)

defineShortcuts({
  meta_o: () => {
    navigateTo('/')
  }
})
</script>

<template>
  <UDashboardSearch
    :open="search.open"
    :placeholder="t('chat.searchPlaceholder')"
    :groups="[{
      id: 'links',
      items: [{
        label: t('chat.new'),
        to: '/',
        icon: 'i-lucide-circle-plus',
        kbds: ['meta', 'o']
      }]
    }, ...groups]"
    @update:open="setSearchOpen"
  />
</template>
