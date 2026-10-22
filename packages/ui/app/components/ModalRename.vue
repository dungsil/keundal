<script setup lang="ts">
const { t } = useLocale()

const props = defineProps<{
  title?: string
}>()

const emit = defineEmits<{ close: [string | false] }>()

const value = ref(props.title ?? '')

const trimmed = computed(() => value.value.trim())

function submit() {
  if (!trimmed.value) return
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
      <UInput
        v-model="value"
        autofocus
        size="lg"
        :placeholder="t('chat.titlePlaceholder')"
        :aria-label="t('chat.titlePlaceholder')"
        class="w-full"
        :ui="{ root: 'w-full' }"
        @keydown.enter.prevent="submit"
      />
    </template>

    <template #footer>
      <UButton :label="t('common.save')" :disabled="!trimmed" @click="submit" />
      <UButton color="neutral" variant="ghost" :label="t('common.cancel')" @click="emit('close', false)" />
    </template>
  </UModal>
</template>
