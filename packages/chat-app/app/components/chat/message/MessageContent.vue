<script setup lang="ts">
import type { ChatMessage } from '../../../../shared/utils/chat-message'

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
      <ChatComark :value="part.text" :streaming="part.state === 'streaming'" />
    </UChatReasoning>

    <template v-else-if="'toolCallId' in part">
      <ChatToolChart v-if="part.type === 'tool-chart'" :invocation="{ ...(part as ChartUIToolInvocation) }" />
      <ChatToolWeather
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
    </template>

    <template v-else-if="part.type === 'text'">
      <ChatComark v-if="message.role === 'assistant'" :value="part.text" :streaming="part.state === 'streaming'" />
      <template v-else-if="message.role === 'user'">
        <ChatMessageEdit
          v-if="editing"
          :message="message"
          :text="part.text"
          @save="(msg, text) => emit('save', msg, text)"
          @cancel="emit('cancelEdit')"
        />
        <p v-else class="whitespace-pre-wrap">
          {{ part.text }}
        </p>
      </template>
    </template>
  </template>
</template>
