<script setup lang="ts">
import { useClipboard } from '@vueuse/core'

import type { ChatMessage } from '@keundal/chat/chat-message'

const { t, intlLocale } = useLocale()

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
  vote: [message: ChatMessage, isUpvoted: boolean]
}>()

const hasFiles = computed(() => props.message.parts.some(part => part.type === 'file'))

const clipboard = useClipboard()

const copied = ref(false)

function copy() {
  clipboard.copy(
    props.message.parts
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join('')
  )

  copied.value = true

  setTimeout(() => {
    copied.value = false
  }, 2000)
}
</script>

<template>
  <template v-if="message.role === 'assistant' && !streaming">
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
        variant="ghost"
        icon="i-lucide-thumbs-up"
        :aria-label="t('chat.good')"
        @click="emit('vote', message, true)"
      />
    </UTooltip>

    <UTooltip :text="t('chat.bad')">
      <UButton
        size="sm"
        :color="vote === false ? 'error' : 'neutral'"
        variant="ghost"
        icon="i-lucide-thumbs-down"
        :aria-label="t('chat.bad')"
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
  </template>

  <template v-if="message.role === 'user' && !streaming && !editing">
    <UTooltip v-if="formattedDate" :text="formattedDate.full">
      <time :datetime="formattedDate.iso" class="text-xs text-muted mr-1.5">
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
        @click="emit('edit', message)"
      />
    </UTooltip>
  </template>
</template>
