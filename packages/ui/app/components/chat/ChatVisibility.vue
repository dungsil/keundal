<script setup lang="ts">
const props = defineProps<{
  chatId: string
  visibility: 'public' | 'private'
}>()

defineEmits<{
  'update:visibility': [visibility: 'public' | 'private']
}>()

const isShared = computed(() => props.visibility === 'public')

const options = [
  {
    value: 'private' as const,
    label: 'Keep private',
    description: 'Only you have access',
    icon: 'i-lucide-lock'
  },
  {
    value: 'public' as const,
    label: 'Shared',
    description: 'Anyone with the link can view',
    icon: 'i-lucide-globe'
  }
]
</script>

<template>
  <UModal
    :title="isShared ? 'Chat shared' : 'Share chat'"
    description="Stored only in this browser. Public sharing is unavailable."
    close
  >
    <UTooltip text="Share chat">
      <UButton color="neutral" variant="ghost" icon="i-lucide-share" aria-label="Share chat" />
    </UTooltip>

    <template #body>
      <div class="flex flex-col gap-0.5 rounded-lg ring ring-default p-1">
        <button
          v-for="option in options"
          :key="option.value"
          :disabled="option.value === 'public'"
          :data-selected="option.value === visibility"
          class="flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-elevated/50 disabled:opacity-50 data-[selected=true]:bg-elevated/50"
        >
          <UIcon :name="option.icon" class="size-5 text-muted shrink-0" />

          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-highlighted">
              {{ option.label }}
            </p>
            <p class="text-sm text-muted">
              {{ option.description }}
            </p>
          </div>

          <UIcon v-if="visibility === option.value" name="i-lucide-circle-check" class="size-5 text-primary shrink-0" />
        </button>
      </div>
    </template>
  </UModal>
</template>
