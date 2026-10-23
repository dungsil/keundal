<script setup lang="ts">
import type { SlotEntryInfo } from '@keundal/ui-slots'
import type { ChatSummary } from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import type { Ref } from 'vue'

import { useLocalizedChats } from '../lib/useLocalizedChats'
import { useChats } from '../lib/useChats'
import { useText } from '../locale'

const props = defineProps<{
  chats: Ref<ChatSummary[] | undefined>
  /** Registered settings sections, listed as commands. */
  settingsSections: Ref<SlotEntryInfo<'settings.section'>[]>
  search: { open: boolean }
  setSearchOpen: (open: boolean) => void
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
}>()

const { t, locale } = useText()
const route = useRoute()
const isSettings = computed(() => route.path === '/settings' || route.path.startsWith('/settings/'))
const { renameChat, deleteChat } = useChatActions({
  rename: (id, title) => props.rename(id, title),
  remove: id => props.remove(id)
})

const localizedChats = useLocalizedChats(() => props.chats.value)
const { groups } = useChats(localizedChats)
const currentChat = computed(() => localizedChats.value?.find(chat => chat.id === route.params.id))
const commandGroups = computed(() => [{
  id: 'links',
  items: [
    { label: t('chat.new'), to: '/', icon: 'i-lucide-circle-plus', kbds: ['meta', 'o'] },
    { label: t('history.title'), to: '/history', icon: 'i-lucide-history' }
  ]
}, {
  id: 'settings',
  label: t('settings.title'),
  items: props.settingsSections.value.map(section => ({
    label: section.meta.label[locale.value],
    icon: section.meta.icon,
    to: { path: `/settings/${section.key}`, query: { returnTo: isSettings.value ? route.query.returnTo : route.path } }
  }))
}, ...(currentChat.value ? [{
  id: 'current-chat',
  label: currentChat.value.label,
  items: [
    { label: t('common.rename'), icon: 'i-lucide-pencil', onSelect: () => runCurrentChatAction('rename') },
    { label: t('common.delete'), icon: 'i-lucide-trash', onSelect: () => runCurrentChatAction('delete') }
  ]
}] : []), ...groups.value])

async function runCurrentChatAction(action: 'rename' | 'delete') {
  const chat = currentChat.value
  if (!chat) return
  props.setSearchOpen(false)
  await nextTick()
  if (action === 'rename') await renameChat(chat.id, chat.untitled ? '' : chat.label)
  else await deleteChat(chat.id)
}

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
    :groups="commandGroups"
    @update:open="setSearchOpen"
  />
</template>
