<script setup lang="ts">
import type { ChatStatus } from '@keundal/chat/chat-message'

import { useText } from '../locale'

const { t } = useText()

defineProps<{
  status: ChatStatus
  running: boolean
  /** The prompt cannot be sent: files are uploading or the composer is disabled. */
  disabled: boolean
  /** The prompt has no text. */
  empty: boolean
}>()

const emit = defineEmits<{
  stop: []
  reload: []
}>()
</script>

<template>
  <div v-if="running" class="flex shrink-0 items-center gap-1">
    <UButton
      icon="i-lucide-square"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="t('chat.stop')"
      @click="emit('stop')"
    />
    <UChatPromptSubmit
      status="ready"
      :disabled="disabled || empty"
      color="neutral"
      size="sm"
    />
  </div>
  <UChatPromptSubmit
    v-else
    :status="status"
    :disabled="disabled"
    v-bind="status === 'error' ? { 'aria-label': t('chat.regenerate') } : {}"
    color="neutral"
    size="sm"
    @stop="emit('stop')"
    @reload="emit('reload')"
  />
</template>
