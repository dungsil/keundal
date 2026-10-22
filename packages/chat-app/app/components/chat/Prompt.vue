<script setup lang="ts">
import type { FileWithStatus } from '@keundal/chat/file'

import type { ChatStatus } from '@keundal/chat/chat-message'
import type { DeliveryMode } from '../../composables/useKeundalChat'

const { t } = useLocale()

const props = withDefaults(
  defineProps<{
    status?: ChatStatus
    error?: Error
    files?: FileWithStatus[]
    uploading?: boolean
    disabled?: boolean
    /** Opens the file picker. */
    open: () => void
  }>(),
  {
    status: 'ready',
    error: undefined,
    files: () => []
  }
)

const emit = defineEmits<{
  submit: [event: Event]
  stop: []
  reload: []
  remove: [id: string]
}>()

const input = defineModel<string>({ default: '' })
/** 실행 중에 보낸 메시지를 대기열에 넣을지, 진행 중인 실행에 지시로 반영할지 정합니다. */
const delivery = defineModel<DeliveryMode>('delivery', { default: 'queue' })

const running = computed(() => props.status === 'submitted' || props.status === 'streaming')
const deliveryModes = computed(() => [
  { value: 'queue' as const, label: t('chat.deliveryQueue'), description: t('chat.deliveryQueueDescription'), icon: 'i-lucide-list-ordered' },
  { value: 'steer' as const, label: t('chat.deliverySteer'), description: t('chat.deliverySteerDescription'), icon: 'i-lucide-corner-down-right' }
])

const dictation = ref<'idle' | 'recording' | 'transcribing'>('idle')
const dictationPreview = ref('')
const placeholder = computed(() => {
  if (dictation.value === 'idle') return t('chat.prompt')
  return (
    dictationPreview.value || (dictation.value === 'recording' ? t('dictation.listening') : t('dictation.transcribing'))
  )
})

const canDictate = computed(
  () => dictation.value !== 'idle' || (props.status === 'ready' && !input.value.trim() && !props.files.length)
)

function appendTranscript(text: string) {
  input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text
}
</script>

<template>
  <UChatPrompt
    v-model="input"
    :status="status"
    :error="error"
    :disabled="uploading || disabled"
    :placeholder="placeholder"
    :aria-label="t('chat.prompt')"
    color="neutral"
    variant="subtle"
    :ui="{ base: ['px-1.5', dictation !== 'idle' && 'placeholder:italic'], footer: 'flex-wrap gap-y-2' }"
    @submit="emit('submit', $event)"
  >
    <template v-if="files.length > 0" #header>
      <ChatFiles :files="files" @remove="emit('remove', $event)" />
    </template>

    <template #footer>
      <ChatPromptMenu :open="open" />

      <div class="flex min-w-0 flex-wrap items-center justify-end gap-1 ml-auto">
        <ModelSelect />
        <ChatReasoningSelect />

        <UFieldGroup v-if="running" size="sm" :aria-label="t('chat.delivery')">
          <UTooltip v-for="mode in deliveryModes" :key="mode.value" :text="mode.description">
            <UButton
              :label="mode.label"
              :icon="mode.icon"
              color="neutral"
              :variant="delivery === mode.value ? 'solid' : 'outline'"
              :aria-pressed="delivery === mode.value"
              @click="delivery = mode.value"
            />
          </UTooltip>
        </UFieldGroup>

        <ChatDictateButton
          v-if="canDictate"
          v-model:state="dictation"
          v-model:preview="dictationPreview"
          :disabled="uploading || disabled"
          @transcript="appendTranscript"
        />
        <template v-else-if="running">
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
            :disabled="uploading || disabled || !input.trim()"
            color="neutral"
            size="sm"
          />
        </template>
        <UChatPromptSubmit
          v-else
          :status="status"
          :disabled="uploading || disabled"
          color="neutral"
          size="sm"
          @stop="emit('stop')"
          @reload="emit('reload')"
        />
      </div>
    </template>
  </UChatPrompt>
</template>
