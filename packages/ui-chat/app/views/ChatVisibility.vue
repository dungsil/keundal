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

function onRadioKeydown(event: KeyboardEvent) {
  const radios = Array.from(
    (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('button[role="radio"]:not([disabled])')
  )
  if (radios.length === 0) return
  const currentIndex = radios.indexOf(event.target as HTMLButtonElement)
  let nextIndex = currentIndex

  if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
    nextIndex = (currentIndex + 1) % radios.length
  } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
    nextIndex = (currentIndex - 1 + radios.length) % radios.length
  } else if (event.key === 'Home') {
    nextIndex = 0
  } else if (event.key === 'End') {
    nextIndex = radios.length - 1
  } else {
    return
  }

  event.preventDefault()
  radios[nextIndex]?.focus()
  const value = radios[nextIndex]?.dataset.value as 'private' | 'public' | undefined
  if (value && value !== 'public') emit('update:visibility', value)
}

const options = computed(() => [
  {
    value: 'private' as const,
    label: t('chat.private'),
    icon: 'i-lucide-lock'
  },
  {
    value: 'public' as const,
    label: t('chat.shared'),
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
      <div role="radiogroup" :aria-label="t('chat.share')" class="flex flex-col gap-0.5 rounded-lg ring ring-default p-1" @keydown="onRadioKeydown">
        <button
          v-for="option in options"
          :key="option.value"
          type="button"
          role="radio"
          :aria-checked="option.value === visibility"
          :disabled="option.value === 'public'"
          :tabindex="option.value === 'public' ? -1 : 0"
          :data-value="option.value"
          :data-selected="option.value === visibility"
          class="flex items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-elevated/50 disabled:opacity-50 data-[selected=true]:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
          @click="option.value !== 'public' && emit('update:visibility', option.value)"
        >
          <UIcon :name="option.icon" class="size-5 text-muted shrink-0" />

          <span class="flex-1 min-w-0 text-sm font-medium text-highlighted">
            {{ option.label }}
          </span>

          <UIcon v-if="visibility === option.value" name="i-lucide-circle-check" class="size-5 text-primary shrink-0" />
        </button>
      </div>
    </template>
  </UModal>
</template>
