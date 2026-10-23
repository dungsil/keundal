<script setup lang="ts">
import type { ToolPart } from '@keundal/chat/chat-message'

import { isToolStreaming } from '../lib/tool'
import { useText } from '../locale'

defineProps<{
  part: ToolPart
}>()

const { t } = useText()
</script>

<template>
  <UChatTool
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
</template>
