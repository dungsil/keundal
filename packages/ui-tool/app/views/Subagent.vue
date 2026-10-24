<script setup lang="ts">
import type { ToolPart } from '@keundal/chat/chat-message'

import { useText } from '../locale'

const props = defineProps<{ part: ToolPart }>()
const { t } = useText()
const status = computed(() => props.part.subagent?.status
  ?? (props.part.state === 'output-available'
    ? 'completed'
    : props.part.state === 'output-error' ? 'cancelled' : 'queued'))
const labels = {
  queued: 'tool.subagentQueued',
  running: 'tool.subagentRunning',
  completed: 'tool.subagentCompleted',
  failed: 'tool.subagentFailed',
  cancelled: 'tool.subagentCancelled'
} as const
const task = computed(() => {
  const input = props.part.input
  return input && typeof input === 'object' && 'task' in input && typeof input.task === 'string' ? input.task : ''
})
const label = computed(() => {
  const input = props.part.input
  return input && typeof input === 'object' && 'label' in input && typeof input.label === 'string' ? input.label : task.value
})
const LABEL_LIMIT = 80
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
// 이모지 같은 서로게이트 쌍과 결합 문자를 가르지 않도록 글자 단위로 자릅니다.
const suffix = computed(() => {
  let count = 0
  for (const { index } of graphemes.segment(label.value)) {
    if (++count > LABEL_LIMIT) return `${label.value.slice(0, index)}…`
  }
  return label.value
})
// 머리글은 폭에 맞춰 잘리므로 작업 지침과 다른 이름은 본문에서 전체를 읽을 수 있게 합니다.
const showLabel = computed(() => label.value !== '' && label.value !== task.value)
const diagnostic = computed(() => {
  const output = props.part.output
  if (output && typeof output === 'object' && 'error' in output && output.error && typeof output.error === 'object'
    && 'message' in output.error && typeof output.error.message === 'string') return output.error.message
  return props.part.subagent?.error ?? ''
})
const answer = computed(() => {
  const output = props.part.output
  return output && typeof output === 'object' && 'content' in output && typeof output.content === 'string' ? output.content : ''
})
const hasBody = computed(() => showLabel.value || !!task.value || !!answer.value || !!diagnostic.value || props.part.state === 'output-error')
</script>

<template>
  <UChatTool
    v-if="hasBody"
    :text="t(labels[status])"
    :suffix="suffix"
    :streaming="status === 'queued' || status === 'running'"
    icon="i-lucide-git-fork"
    chevron="leading"
  >
    <div class="space-y-3 text-sm break-words">
      <p v-if="showLabel" class="whitespace-pre-wrap break-words">
        {{ label }}
      </p>
      <p class="whitespace-pre-wrap break-words">
        {{ task }}
      </p>
      <p v-if="answer && status === 'failed'" class="text-muted">
        {{ t('tool.subagentPartial') }}
      </p>
      <ChatComark v-if="answer" :value="answer" />
      <p v-if="diagnostic" class="text-error whitespace-pre-wrap break-words">
        {{ diagnostic }}
      </p>
      <p v-if="part.state === 'output-error'" class="text-muted">
        {{ t(labels[status]) }}
      </p>
    </div>
  </UChatTool>
  <UChatTool
    v-else
    :text="t(labels[status])"
    :suffix="suffix"
    :streaming="status === 'queued' || status === 'running'"
    icon="i-lucide-git-fork"
    chevron="leading"
  />
</template>
