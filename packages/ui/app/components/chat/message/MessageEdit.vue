<script setup lang="ts">
import type { ChatMessage } from '#shared/utils/chat-message'

const { t } = useLocale()

const props = defineProps<{
  message: ChatMessage
  text: string
}>()

const emit = defineEmits<{
  save: [message: ChatMessage, text: string]
  cancel: []
}>()

const editingText = ref(props.text)
</script>

<template>
  <div class="flex flex-col gap-2 w-full">
    <UTextarea v-model="editingText" autofocus autoresize :rows="1" size="xl" variant="none" :ui="{ base: 'p-0' }" />

    <div class="flex gap-1.5 justify-end">
      <UButton size="sm" variant="soft" color="neutral" :label="t('common.cancel')" @click="emit('cancel')" />
      <UButton
        size="sm"
        :label="t('common.save')"
        :disabled="!editingText.trim() || editingText === text"
        @click="emit('save', message, editingText)"
      />
    </div>
  </div>
</template>
