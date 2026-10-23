<script setup lang="ts">
import type { ChartUIToolInvocation } from '@keundal/chat/tools/chart'
import type { WeatherUIToolInvocation } from '@keundal/chat/tools/weather'

import type { ChatMessage } from '@keundal/chat/chat-message'

const { t } = useLocale()

defineProps<{
  message: ChatMessage
  editing: boolean
}>()

const emit = defineEmits<{
  save: [message: ChatMessage, text: string]
  cancelEdit: []
}>()
</script>

<template>
  <template v-for="(part, index) in getMergedParts(message.parts)" :key="`${message.id}-${part.type}-${index}`">
    <UChatReasoning
      v-if="part.type === 'reasoning'"
      :text="part.text"
      :streaming="part.state === 'streaming'"
      chevron="leading"
    >
      <ChatComark dir="auto" class="wrap-break-word" :value="part.text" :streaming="part.state === 'streaming'" />
    </UChatReasoning>

    <template v-else-if="'toolCallId' in part">
      <LazyChatToolChart v-if="part.type === 'tool-chart'" :invocation="{ ...(part as ChartUIToolInvocation) }" />
      <LazyChatToolWeather
        v-else-if="part.type === 'tool-weather'"
        :invocation="{ ...(part as WeatherUIToolInvocation) }"
      />
      <ChatToolSubagent
        v-else-if="part.type === 'tool-delegate_task'"
        :invocation="part"
      />
      <UChatTool
        v-else-if="part.type === 'tool-skill'"
        :text="
          part.state === 'output-error'
            ? t('tool.skillInterrupted')
            : isToolStreaming(part)
              ? t('tool.skillLoading')
              : t('tool.skillLoaded')
        "
        :suffix="(part.input as { name?: string })?.name"
        :streaming="isToolStreaming(part)"
        chevron="leading"
      >
        <pre class="text-xs whitespace-pre-wrap break-words">{{
          part.state === 'output-error' ? part.errorText : part.output
        }}</pre>
      </UChatTool>
      <UChatTool
        v-else-if="part.type === 'tool-web_search' || part.type === 'tool-google_search'"
        :text="isToolStreaming(part) ? t('tool.searching') : t('tool.searched')"
        :suffix="getSearchQuery(part)"
        :streaming="isToolStreaming(part)"
        chevron="leading"
      >
        <ChatToolSources :sources="getSources(part)" />
      </UChatTool>
      <UChatTool
        v-else
        :text="t(part.state === 'output-error' ? 'plugin.toolFailed' : isToolStreaming(part) ? 'plugin.toolRunning' : 'plugin.toolFinished')"
        :suffix="part.type.slice(5)"
        :streaming="isToolStreaming(part)"
        chevron="leading"
      >
        <pre class="text-xs whitespace-pre-wrap break-words">{{ JSON.stringify(part.input, null, 2) }}</pre>
        <pre class="mt-2 text-xs whitespace-pre-wrap break-words">{{ part.state === 'output-error' ? part.errorText : typeof part.output === 'string' ? part.output : JSON.stringify(part.output, null, 2) }}</pre>
      </UChatTool>
    </template>

    <template v-else-if="part.type === 'text'">
      <ChatComark v-if="message.role === 'assistant'" dir="auto" class="wrap-break-word" :value="part.text" :streaming="part.state === 'streaming'" />
      <template v-else-if="message.role === 'user'">
        <ChatMessageEdit
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
