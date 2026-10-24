<script setup lang="ts">
import type { ExecutionOptions, GenerationSnapshot } from '@keundal/core'
import type { ChatMessageFooterOwner } from '@keundal/ui-chat/slots'

import { traceRunIds, type LiveTrace } from '../lib/live-trace'
import TraceViewer from './TraceViewer.vue'

const props = defineProps<{
  message: ChatMessageFooterOwner['message']
  messages: ChatMessageFooterOwner['messages']
  status: ChatMessageFooterOwner['status']
  trace: LiveTrace
  getRun: (runId: string, options?: ExecutionOptions) => Promise<GenerationSnapshot | undefined>
}>()

const visible = computed(() => props.message.role === 'assistant' && traceRunIds(props.messages).has(props.message.id))
const liveSpans = computed(() => [...props.trace.spans.values()])
</script>

<template>
  <TraceViewer
    v-if="visible"
    :run-id="message.id"
    :live="status === 'streaming' && message.id === messages[messages.length - 1]?.id"
    :live-spans="message.id === trace.activeRunId ? liveSpans : undefined"
    :get-run="getRun"
  />
</template>
