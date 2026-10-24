<script setup lang="ts">
import { useText } from '../locale'

const { t } = useText()

const props = defineProps<{
  chatId: string
  visibility: 'public' | 'private'
}>()

const emit = defineEmits<{
  'update:visibility': [visibility: 'public' | 'private']
}>()

const isShared = computed(() => props.visibility === 'public')

const options = computed(() => [
  {
    value: 'private' as const,
    label: t('chat.private'),
    description: t('chat.privateDescription'),
    icon: 'i-lucide-lock'
  },
  {
    value: 'public' as const,
    label: t('chat.shared'),
    description: t('chat.sharedDescription'),
    icon: 'i-lucide-globe'
  }
])
</script>

<template>
  <UModal :title="isShared ? t('chat.sharedTitle') : t('chat.share')" :description="t('chat.sharingUnavailable')" close>
    <UTooltip :text="t('chat.share')">
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-share"
        :aria-label="t('chat.share')"
      />
    </UTooltip>

    <template #body>
      <div role="radiogroup" :aria-label="t('chat.share')" class="flex flex-col gap-0.5 rounded-lg ring ring-default p-1">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="option.value === visibility"
          :disabled="option.value === 'public'"
          :data-selected="option.value === visibility"
          class="flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-elevated/50 disabled:opacity-50 data-[selected=true]:bg-elevated/50"
          @click="option.value !== 'public' && emit('update:visibility', option.value)"
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
