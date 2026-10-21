<script setup lang="ts">
import type { ToolPart } from '../../../../shared/utils/chat-message'

const props = defineProps<{ invocation: ToolPart }>()
const { t } = useLocale()
const status = computed(() => props.invocation.subagent?.status
  ?? (props.invocation.state === 'output-available'
    ? 'completed'
    : props.invocation.state === 'output-error' ? 'cancelled' : 'queued'))
const labels = {
  queued: 'tool.subagentQueued',
  running: 'tool.subagentRunning',
  completed: 'tool.subagentCompleted',
  failed: 'tool.subagentFailed',
  cancelled: 'tool.subagentCancelled'
} as const
const task = computed(() => {
  const input = props.invocation.input
  return input && typeof input === 'object' && 'task' in input && typeof input.task === 'string' ? input.task : ''
})
const answer = computed(() => {
  const output = props.invocation.output
  return output && typeof output === 'object' && 'content' in output && typeof output.content === 'string' ? output.content : ''
})
</script>

<template>
  <UChatTool
    :text="t(labels[status])"
    :suffix="task.length > 80 ? `${task.slice(0, 80)}…` : task"
    :streaming="status === 'queued' || status === 'running'"
    icon="i-lucide-git-fork"
    chevron="leading"
  >
    <div class="space-y-3 text-sm">
      <p class="whitespace-pre-wrap break-words">
        {{ task }}
      </p>
      <ChatComark v-if="answer" :value="answer" />
      <p v-if="invocation.state === 'output-error'" class="text-muted">
        {{ t(labels[status]) }}
      </p>
    </div>
  </UChatTool>
</template>
