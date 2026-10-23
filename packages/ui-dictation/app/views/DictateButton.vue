<script setup lang="ts">
import type { TranscriptionStream } from '@keundal/chat/platform'
import type { DictationState } from '@keundal/ui-composer/slots'

import { useDictation } from '../lib/use-dictation'
import { useText } from '../locale'

const { t } = useText()

const props = defineProps<{
  /** Dictation state the composer reflects, for example in its placeholder. */
  state: DictationState
  setState: (state: DictationState) => void
  /** Interim transcript shown as the composer's placeholder. */
  setPreview: (text: string) => void
  disabled: boolean
  appendTranscript: (text: string) => void
  ensureConfigured: (model: string) => boolean
  transcriptionSampleRate: () => number
  transcribe: (audio: ReadableStream<Float32Array>, signal: AbortSignal) => Promise<TranscriptionStream>
}>()

const toast = useToast()
const { supported, recording, finalizing, level, transcript, error, start, stop, cancel } = useDictation({
  sampleRate: () => props.transcriptionSampleRate(),
  transcribe: (audio, signal) => props.transcribe(audio, signal),
  denied: () => t('dictation.denied')
})
const root = useTemplateRef('root')
const micButton = useTemplateRef<{ $el: HTMLElement }>('micButton')
const finishButton = useTemplateRef<{ $el: HTMLElement }>('finishButton')

// Rolling input levels rendered as a small waveform while recording
const BARS = 14
const bars = ref<number[]>(Array.from({ length: BARS }, () => 0))
let sampler: number | undefined

watch(recording, (value) => {
  clearInterval(sampler)
  if (value) {
    bars.value = Array.from({ length: BARS }, () => 0)
    sampler = window.setInterval(() => {
      bars.value = [...bars.value.slice(1), level.value]
    }, 80)
  }
})

// Every state swaps its buttons out, which drops a keyboard user's focus on the page.
// Hand focus to the control that takes over, unless the user already moved it elsewhere.
let restoreFocus = false

watch([recording, finalizing], async ([isRecording, isFinalizing]) => {
  props.setState(isRecording ? 'recording' : isFinalizing ? 'transcribing' : 'idle')

  if (root.value?.contains(document.activeElement)) restoreFocus = true
  await nextTick()
  if (!restoreFocus) return

  const active = document.activeElement
  if (active && active !== document.body && !root.value?.contains(active)) {
    restoreFocus = false
    return
  }
  if (isRecording) {
    finishButton.value?.$el.focus()
  } else if (!isFinalizing) {
    micButton.value?.$el.focus()
    restoreFocus = false
  }
})

watch(transcript, (value) => {
  props.setPreview(value)
})

watch(error, (value) => {
  if (value) fail(value)
})

const tooltip = computed(() => {
  if (!supported.value) return t('dictation.unsupported')
  return t('dictation.dictate')
})

function fail(cause: Error) {
  toast.add({
    title: t('dictation.failed'),
    description: cause.message,
    icon: 'i-lucide-alert-circle',
    color: 'error',
    duration: 0,
    // An error message from the provider can be one long token, let it wrap inside the toast
    ui: { description: 'break-words' }
  })
}

async function record() {
  if (!supported.value) {
    toast.add({ description: tooltip.value, icon: 'i-lucide-info', color: 'neutral' })
    return
  }
  if (!props.ensureConfigured('openai/gpt-5-nano')) return

  try {
    await start({ onMaxDuration: finish })
  } catch (cause) {
    fail(cause as Error)
  }
}

async function finish() {
  try {
    const text = await stop()
    if (text) {
      props.appendTranscript(text)
    }
  } catch (cause) {
    fail(cause as Error)
  }
}

onBeforeUnmount(() => {
  clearInterval(sampler)
  // The prompt swaps this button out when text is typed, do not leave it thinking we are still recording
  props.setState('idle')
  props.setPreview('')
})
</script>

<template>
  <div ref="root" class="flex items-center gap-1">
    <span role="status" class="sr-only">{{ state === 'recording' ? t('dictation.listening') : state === 'transcribing' ? t('dictation.transcribing') : '' }}</span>
    <template v-if="recording || finalizing">
      <div v-if="recording" class="flex items-center gap-0.75 h-7 px-2 motion-reduce:hidden" aria-hidden="true">
        <span
          v-for="(bar, index) in bars"
          :key="index"
          class="w-0.5 rounded-full bg-inverted/80 motion-safe:transition-[height] duration-75"
          :style="{ height: `${Math.max(2, Math.round(bar * 18))}px` }"
        />
      </div>

      <UButton
        v-if="recording"
        icon="i-lucide-x"
        color="neutral"
        variant="subtle"
        size="sm"
        :aria-label="t('dictation.cancel')"
        @click="cancel()"
      />
      <UButton
        ref="finishButton"
        icon="i-lucide-check"
        color="neutral"
        size="sm"
        :loading="finalizing"
        :aria-label="t('dictation.finish')"
        @click="finish"
      />
    </template>

    <UTooltip v-else :text="tooltip" :content="{ side: 'top' }">
      <UButton
        ref="micButton"
        icon="i-lucide-mic"
        color="neutral"
        variant="ghost"
        size="sm"
        :disabled="disabled"
        :aria-label="t('dictation.dictate')"
        @click="record"
      />
    </UTooltip>
  </div>
</template>
