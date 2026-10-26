<script setup lang="ts">
import { useClipboard } from '@vueuse/core'

import type { ChatMessage } from '@keundal/chat/chat-message'
import { getMarkdownContent } from '@keundal/chat/tools/markdown'
import { messagePermalink } from '../../lib/chat-transcript'
import { getMergedParts } from '../../lib/messages'
import { useText } from '../../locale'

const { t, intlLocale } = useText()

const props = defineProps<{
  message: ChatMessage & { createdAt?: string | Date }
  streaming: boolean
  editing: boolean
  vote: boolean | null
}>()

const formattedDate = computed(() => {
  if (!props.message.createdAt) return null

  const date = new Date(props.message.createdAt)

  return {
    time: date.toLocaleTimeString(intlLocale.value, { hour: 'numeric', minute: '2-digit' }),
    full: date.toLocaleString(intlLocale.value, { dateStyle: 'medium', timeStyle: 'short' }),
    iso: date.toISOString()
  }
})

const emit = defineEmits<{
  edit: [message: ChatMessage]
  regenerate: [message: ChatMessage]
  branch: [message: ChatMessage]
  vote: [message: ChatMessage, isUpvoted: boolean]
}>()

const hasFiles = computed(() => props.message.parts.some(part => part.type === 'file'))

const clipboard = useClipboard()

const copied = ref(false)
const toast = useToast()
let copiedTimer: ReturnType<typeof setTimeout> | undefined
onBeforeUnmount(() => clearTimeout(copiedTimer))

async function copyLink() {
  try {
    await navigator.clipboard.writeText(messagePermalink(window.location.href, props.message.id))
    toast.add({ description: t('chat.copied'), icon: 'i-lucide-check' })
  } catch {
    toast.add({ description: t('chat.copyFailed'), color: 'error' })
  }
}

async function copy() {
  try {
    await clipboard.copy(
      getMergedParts(props.message.parts)
        .flatMap(part => {
          if (part.type === 'text') return [part.text]
          if ('toolCallId' in part && part.state === 'output-available') return getMarkdownContent(part) ?? []
          return []
        })
        .join('\n\n')
    )

    copied.value = true

    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => {
      copied.value = false
    }, 2000)
  } catch {
    toast.add({ description: t('chat.copyFailed'), color: 'error' })
  }
}
</script>

<template>
  <UTooltip v-if="!streaming && !editing" :text="t('chat.copyLink')">
    <UButton
      size="sm"
      color="neutral"
      variant="ghost"
      icon="i-lucide-link"
      :aria-label="t('chat.copyLink')"
      :data-message-link="message.id"
      @click="copyLink"
    />
  </UTooltip>
  <template v-if="message.role === 'assistant' && !streaming">
    <span role="status" class="sr-only">{{ copied ? t('chat.copied') : '' }}</span>

    <UTooltip :text="t('chat.copy')">
      <UButton
        size="sm"
        :color="copied ? 'primary' : 'neutral'"
        variant="ghost"
        :icon="copied ? 'i-lucide-copy-check' : 'i-lucide-copy'"
        :aria-label="t('chat.copy')"
        @click="copy"
      />
    </UTooltip>

    <UTooltip :text="t('chat.good')">
      <UButton
        size="sm"
        :color="vote === true ? 'success' : 'neutral'"
        :variant="vote === true ? 'soft' : 'ghost'"
        icon="i-lucide-thumbs-up"
        :aria-label="t('chat.good')"
        :aria-pressed="vote === true"
        :class="{ 'ring-1 ring-current': vote === true }"
        @click="emit('vote', message, true)"
      />
    </UTooltip>

    <UTooltip :text="t('chat.bad')">
      <UButton
        size="sm"
        :color="vote === false ? 'error' : 'neutral'"
        :variant="vote === false ? 'soft' : 'ghost'"
        icon="i-lucide-thumbs-down"
        :aria-label="t('chat.bad')"
        :aria-pressed="vote === false"
        :class="{ 'ring-1 ring-current': vote === false }"
        @click="emit('vote', message, false)"
      />
    </UTooltip>

    <UTooltip :text="t('chat.regenerate')">
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-rotate-cw"
        :aria-label="t('chat.regenerate')"
        @click="emit('regenerate', message)"
      />
    </UTooltip>

    <UTooltip :text="t('chat.branch')">
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-git-branch"
        :aria-label="t('chat.branch')"
        :data-message-branch="message.id"
        @click="emit('branch', message)"
      />
    </UTooltip>
  </template>

  <template v-if="message.role === 'user' && !streaming && !editing">
    <UTooltip v-if="formattedDate" :text="formattedDate.full">
      <time :datetime="formattedDate.iso" tabindex="0" class="text-xs text-muted mr-1.5">
        {{ formattedDate.time }}
      </time>
    </UTooltip>

    <UTooltip v-if="!hasFiles" :text="t('chat.editMessage')">
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-pencil"
        :aria-label="t('chat.editMessage')"
        :data-message-edit="message.id"
        @click="emit('edit', message)"
      />
    </UTooltip>

    <UTooltip :text="t('chat.branch')">
      <UButton
        size="sm"
        color="neutral"
        variant="ghost"
        icon="i-lucide-git-branch"
        :aria-label="t('chat.branch')"
        :data-message-branch="message.id"
        @click="emit('branch', message)"
      />
    </UTooltip>
  </template>
</template>
