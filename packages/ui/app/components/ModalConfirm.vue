<script setup lang="ts">
const { t } = useLocale()

defineProps<{
  title: string
  description: string
  color?: 'error' | 'warning' | 'info' | 'success'
}>()

const emit = defineEmits<{ close: [boolean] }>()
</script>

<template>
  <UModal
    :title="title"
    :description="description"
    :ui="{
      header: 'items-start overflow-y-auto',
      wrapper: 'min-w-0',
      title: 'break-words',
      description: 'break-words',
      footer: 'justify-end'
    }"
    :content="{ onEscapeKeyDown: () => emit('close', false) }"
    :close="false"
    :dismissible="false"
  >
    <template #footer>
      <UButton color="neutral" variant="ghost" :label="t('common.cancel')" autofocus @click="emit('close', false)" />
      <UButton :color="color" :label="t('common.delete')" @click="emit('close', true)" />
    </template>
  </UModal>
</template>
