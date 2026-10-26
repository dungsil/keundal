<script setup lang="ts">
import type { ToolPart } from '@keundal/chat/chat-message'
import { getMarkdownContent } from '@keundal/chat/tools/markdown'

import { isToolStreaming } from '../lib/tool'
import { useText } from '../locale'

const props = defineProps<{ part: ToolPart }>()
const { t } = useText()
const content = computed(() => getMarkdownContent(props.part))
</script>

<template>
  <LazyChatComark v-if="content !== undefined" dir="auto" class="wrap-break-word" :value="content" />
  <UChatTool
    v-else
    :text="t(part.state === 'output-error' ? 'tool.markdownFailed' : isToolStreaming(part) ? 'tool.markdownLoading' : 'tool.markdownFinished')"
    suffix="markdown"
    :streaming="isToolStreaming(part)"
    chevron="leading"
  >
    <p v-if="part.state === 'output-error'" class="whitespace-pre-wrap break-words">{{ part.errorText }}</p>
  </UChatTool>
</template>
