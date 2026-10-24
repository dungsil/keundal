<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import { computed } from 'vue'

import { useText } from '../locale'

const { t } = useText()

const props = defineProps<{
  chatId: string
  title?: string | null
  isOwner: boolean
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
}>()

const emit = defineEmits<{
  'update:title': [title: string]
}>()

const { renameChat, deleteChat } = useChatActions({
  rename: (id, title) => props.rename(id, title),
  remove: id => props.remove(id)
})

const displayTitle = computed(() => props.title || t('chat.untitled'))
const popoverContent = computed(() => ({ align: 'start' as const, 'aria-label': displayTitle.value }))

async function renameTitle() {
  const newTitle = await renameChat(props.chatId, props.title)
  if (newTitle) emit('update:title', newTitle)
}

const items = computed<DropdownMenuItem[][]>(() => [
  ...(props.title ? [[{ slot: 'title' as const, type: 'label' as const, label: props.title }]] : []),
  [
    {
      label: t('common.rename'),
      icon: 'i-lucide-pencil',
      onSelect: renameTitle
    }
  ],
  [
    {
      label: t('common.delete'),
      icon: 'i-lucide-trash',
      color: 'error' as const,
      onSelect: () => deleteChat(props.chatId)
    }
  ]
])
</script>

<template>
  <UPopover
    v-if="!isOwner"
    :content="popoverContent"
    :ui="{ content: 'max-w-[min(24rem,calc(100vw-2rem))] p-3' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      trailing-icon="i-lucide-chevron-down"
      class="min-w-0 max-w-3xs"
    >
      <span dir="auto" class="truncate">{{ displayTitle }}</span>
    </UButton>

    <template #content>
      <p dir="auto" class="text-sm leading-normal whitespace-pre-wrap [overflow-wrap:anywhere]">{{ displayTitle }}</p>
    </template>
  </UPopover>

  <UDropdownMenu
    v-else
    :items="items"
    :content="{ align: 'end' }"
    :ui="{ content: 'min-w-44 max-w-[min(24rem,calc(100vw-2rem))]' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      trailing-icon="i-lucide-chevron-down"
      :class="['group min-w-0 max-w-3xs data-[state=open]:bg-elevated', { 'text-muted data-[state=open]:text-toned': !title }]"
      :ui="{
        trailingIcon: 'text-muted shrink-0 group-data-[state=open]:rotate-180 motion-safe:transition-transform duration-200'
      }"
    >
      <span dir="auto" class="truncate">{{ displayTitle }}</span>
    </UButton>

    <template #title-label>
      <span dir="auto" class="block whitespace-pre-wrap [overflow-wrap:anywhere]">{{ displayTitle }}</span>
    </template>
  </UDropdownMenu>
</template>
