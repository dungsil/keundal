<script setup lang="ts">
const { t } = useLocale()

const props = defineProps<{
  title?: string
}>()

const emit = defineEmits<{ close: [string | false] }>()

// 저장소의 제목 한도(validateChatTitle: 1–100자, UTF-16 단위)와 같은 값입니다.
const MAX_TITLE_LENGTH = 100

const value = ref(props.title ?? '')

const trimmed = computed(() => value.value.trim())
const invalid = ref(false)

watch(trimmed, (title) => {
  if (title) invalid.value = false
})

async function submit() {
  if (!trimmed.value) {
    invalid.value = true
    await nextTick()
    document.getElementById('chat-title-input')?.focus()
    return
  }
  emit('close', trimmed.value)
}
</script>

<template>
  <UModal
    :title="t('chat.renameTitle')"
    :description="t('chat.renameDescription')"
    :ui="{
      footer: 'flex-row-reverse justify-start'
    }"
    :close="false"
  >
    <template #body>
      <label for="chat-title-input" class="sr-only">{{ t('chat.titlePlaceholder') }}</label>
      <UInput
        id="chat-title-input"
        v-model="value"
        autofocus
        size="lg"
        :aria-invalid="invalid ? 'true' : undefined"
        :aria-describedby="invalid ? 'chat-title-error' : undefined"
        :placeholder="t('chat.titlePlaceholder')"
        :aria-label="t('chat.titlePlaceholder')"
        :maxlength="MAX_TITLE_LENGTH"
        class="w-full"
        :ui="{ root: 'w-full' }"
        @keydown.enter.prevent="submit"
      />
      <p v-if="invalid" id="chat-title-error" class="mt-2 text-sm text-error">
        {{ t('chat.titleRequired') }}
      </p>
    </template>

    <template #footer>
      <UButton :label="t('common.save')" @click="submit" />
      <UButton color="neutral" variant="ghost" :label="t('common.cancel')" @click="emit('close', false)" />
    </template>
  </UModal>
</template>
