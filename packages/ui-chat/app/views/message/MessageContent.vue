<script setup lang="ts">
import type { ChatMessage, ToolPart } from '@keundal/chat/chat-message'
import { SlotOutlet } from '@keundal/ui-slots'
import { getDomain } from '@keundal/ui/app/utils/url.ts'

import { getMergedParts } from '../../lib/messages'
import { useText } from '../../locale'
import MessageEdit from './MessageEdit.vue'

const { t } = useText()

defineProps<{
  message: ChatMessage
  editing: boolean
}>()

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
      <p dir="auto" class="whitespace-pre-wrap wrap-break-word">{{ part.text }}</p>
    </UChatReasoning>

    <template v-else-if="'toolCallId' in part">
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

    <div v-else-if="part.type === 'source-url'" class="my-1">
      <ChatSourceLink :url="part.url" :label="part.title || getDomain(part.url)" />
    </div>

    <template v-else-if="part.type === 'text'">
      <p v-if="message.role === 'assistant'" dir="auto" class="whitespace-pre-wrap wrap-break-word">{{ part.text }}</p>
      <template v-else-if="message.role === 'user'">
        <MessageEdit
          v-if="editing"
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
