<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'

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
const inputId = useId()
const editor = useTemplateRef('editor')
const invalid = ref(false)
watch(editingText, () => { invalid.value = false })

function save() {
  invalid.value = !editingText.value.trim()
  if (invalid.value) {
    editor.value?.textareaRef?.focus()
    return
  }
  if (editingText.value === props.text) {
    emit('cancel')
    return
  }
  emit('save', props.message, editingText.value)
}
</script>

<template>
  <form class="flex flex-col gap-2 w-full" @submit.prevent="save">
    <label :for="inputId" class="sr-only">{{ t('chat.editMessage') }}</label>
    <UTextarea
      ref="editor"
      :aria-invalid="invalid || undefined"
      :aria-describedby="invalid ? `${inputId}-error` : undefined"
      :id="inputId"
      name="message"
      dir="auto"
      v-model="editingText"
      autofocus
      autoresize
      :rows="1"
      size="xl"
      variant="none"
      :ui="{ base: 'p-0 focus-visible:outline-auto' }"
    />
    <p v-if="invalid" :id="`${inputId}-error`" class="text-sm text-error">{{ t('chat.messageRequired') }}</p>

    <div class="flex gap-1.5 justify-end">
      <UButton
        size="sm"
        variant="soft"
        color="neutral"
        :label="t('common.cancel')"
        @click="emit('cancel')"
      />
      <UButton
        type="submit"
        size="sm"
        :label="t('common.save')"
      />
    </div>
  </form>
</template>
