<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const { t } = useLocale()

const props = defineProps<{
  chatId: string
  title?: string | null
  isOwner: boolean
}>()

const emit = defineEmits<{
  'update:title': [title: string]
}>()

const { renameChat, deleteChat } = useChatActions()

const displayTitle = computed(() => props.title || t('chat.untitled'))
const popoverContent = computed(() => ({ align: 'start' as const, 'aria-label': displayTitle.value }))

async function rename() {
  const newTitle = await renameChat(props.chatId, props.title)
  if (newTitle) emit('update:title', newTitle)
}

const items = computed<DropdownMenuItem[][]>(() => [
  ...(props.title ? [[{ slot: 'title' as const, type: 'label' as const, label: props.title }]] : []),
  [
    {
      label: t('common.rename'),
      icon: 'i-lucide-pencil',
      onSelect: rename
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

    <template #title-label="{ item }">
      <span dir="auto" class="block whitespace-pre-wrap [overflow-wrap:anywhere]">{{ item.label }}</span>
    </template>
  </UDropdownMenu>
</template>
