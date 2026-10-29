<script setup lang="ts">
import type { ExecutionOptions } from '@keundal/core'
import type { GenerationSnapshot } from '@keundal/generation'
import type { ChatIndicatorOwner } from '@keundal/ui/app/contracts/chat.ts'

import { showRootTrace, type LiveTrace } from '../lib/live-trace'
import TraceViewer from './TraceViewer.vue'

const props = defineProps<{
  messages: ChatIndicatorOwner['messages']
  status: ChatIndicatorOwner['status']
  trace: LiveTrace
  getRun: (runId: string, options?: ExecutionOptions) => Promise<GenerationSnapshot | undefined>
}>()

const visible = computed(() => showRootTrace(props.trace, props.messages))
const liveSpans = computed(() => [...props.trace.spans.values()])
</script>

<template>
  <TraceViewer v-if="visible" :run-id="trace.activeRunId!" :live="status === 'streaming'" :live-spans="liveSpans" :get-run="getRun" />
</template>
