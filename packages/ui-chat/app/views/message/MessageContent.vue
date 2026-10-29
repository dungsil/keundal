<script setup lang="ts">
import type { ChatMessage, ToolPart } from '@keundal/chat/chat-message'
import type { ToolApprovalRecord } from '@keundal/tool-approval'
import { SlotOutlet } from '@keundal/ui-slots'
import { reactive } from 'vue'

import { getMergedParts } from '../../lib/messages'
import { useText } from '../../locale'
import MessageEdit from './MessageEdit.vue'

const { t } = useText()

const props = defineProps<{
  message: ChatMessage
  editing: boolean
  respondToToolApproval: (runId: string, requestId: string, decision: 'allow' | 'deny') => Promise<boolean>
}>()

const sending = reactive(new Set<string>())
const submitted = reactive(new Set<string>())
const errors = reactive<Record<string, string>>({})

async function respond(approval: ToolApprovalRecord, decision: 'allow' | 'deny') {
  if (sending.has(approval.requestId) || submitted.has(approval.requestId)) return
  sending.add(approval.requestId)
  delete errors[approval.requestId]
  try {
    if (!await props.respondToToolApproval(approval.runId, approval.requestId, decision)) {
      submitted.add(approval.requestId)
      errors[approval.requestId] = t('approval.expired')
      return
    }
    submitted.add(approval.requestId)
  } catch {
    errors[approval.requestId] = t('approval.failed')
  } finally {
    sending.delete(approval.requestId)
  }
}

const emit = defineEmits<{
  save: [message: ChatMessage, text: string]
  cancelEdit: []
}>()

function isToolStreaming(part: ToolPart): boolean {
  return part.state === 'input-streaming' || part.state === 'input-available'
}
</script>

<template>
  <template v-for="(part, index) in getMergedParts(message.parts)" :key="`${message.id}-${part.type}-${index}`">
    <UChatReasoning
      v-if="part.type === 'reasoning'"
      :text="part.text"
      :streaming="part.state === 'streaming'"
      chevron="leading"
    >
      <ChatMarkdown dir="auto" class="wrap-break-word" :value="part.text" :streaming="part.state === 'streaming'" />
    </UChatReasoning>

    <template v-else-if="'toolCallId' in part">
      <section v-for="approval in part.approvals" :key="approval.requestId" class="my-3 rounded-lg border border-default bg-muted p-4 text-sm" :aria-label="t('approval.title')">
        <p class="font-medium">{{ approval.status === 'requested' && part.state === 'input-available' ? t('approval.title') : approval.status === 'decided' ? t(approval.decision === 'allow' ? 'approval.allowed' : 'approval.denied') : t('approval.expired') }}</p>
        <dl class="mt-3 space-y-2">
          <div><dt class="text-muted">{{ t('approval.operation') }}</dt><dd class="break-all font-mono">{{ approval.toolName }} · {{ approval.operation.kind }}</dd></div>
          <div v-if="approval.operation.command"><dt class="text-muted">{{ t('approval.command') }}</dt><dd><pre class="whitespace-pre-wrap break-all">{{ approval.operation.command }}</pre></dd></div>
          <div v-if="approval.operation.paths"><dt class="text-muted">{{ t('approval.paths') }}</dt><dd class="whitespace-pre-wrap break-all font-mono">{{ approval.operation.paths.join('\n') || t('approval.defaultPath') }}</dd></div>
        </dl>
        <pre v-if="!approval.operation.command && !approval.operation.paths" class="mt-2 whitespace-pre-wrap break-all text-xs">{{ JSON.stringify(approval.arguments, null, 2) }}</pre>
        <div v-if="approval.status === 'requested' && part.state === 'input-available'" class="mt-4 flex gap-2">
          <UButton color="neutral" variant="outline" :disabled="sending.has(approval.requestId) || submitted.has(approval.requestId)" @click="respond(approval, 'deny')">{{ t('approval.deny') }}</UButton>
          <UButton :loading="sending.has(approval.requestId)" :disabled="submitted.has(approval.requestId)" @click="respond(approval, 'allow')">{{ t('approval.allow') }}</UButton>
        </div>
        <p v-if="errors[approval.requestId]" role="alert" class="mt-2 text-error">{{ errors[approval.requestId] }}</p>
      </section>
      <SlotOutlet name="chat.message.tool" :entry-key="part.type.slice(5)" :owner="{ part, message }">
        <template #fallback>
          <UChatTool
            :text="t(part.state === 'output-error' ? 'plugin.toolFailed' : isToolStreaming(part) ? 'plugin.toolRunning' : 'plugin.toolFinished')"
            :suffix="part.type.slice(5)"
            :streaming="isToolStreaming(part)"
            chevron="leading"
          >
            <pre class="text-xs whitespace-pre-wrap break-words">{{ JSON.stringify(part.input, null, 2) }}</pre>
            <pre class="mt-2 text-xs whitespace-pre-wrap break-words">{{ part.state === 'output-error' ? part.errorText : typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2) }}</pre>
          </UChatTool>
        </template>
      </SlotOutlet>
    </template>

    <template v-else-if="part.type === 'text'">
      <p v-if="part.role && part.role !== 'assistant' && message.role === 'assistant'" class="mt-3 text-xs font-medium text-muted">{{ part.role }}</p>
      <ChatMarkdown v-if="(part.role ?? message.role) === 'assistant'" dir="auto" class="wrap-break-word" :value="part.text" :streaming="part.state === 'streaming'" :sources="part.sources" />
      <template v-else>
        <MessageEdit
          v-if="editing && message.role === 'user'"
          :message="message"
          :text="part.text"
          @save="(msg, text) => emit('save', msg, text)"
          @cancel="emit('cancelEdit')"
        />
        <p v-else dir="auto" class="whitespace-pre-wrap wrap-break-word">
          {{ part.text }}
        </p>
      </template>
    </template>
  </template>
</template>
