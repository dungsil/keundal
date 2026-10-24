<script setup lang="ts">
import type { ToolPart } from '@keundal/chat/chat-message'

import { getSearchQuery, getSources, isToolStreaming } from '../lib/tool'
import { useText } from '../locale'
import Sources from './Sources.vue'

defineProps<{
  part: ToolPart
}>()

const { t } = useText()
</script>

<template>
  <UChatTool
    :text="isToolStreaming(part) ? t('tool.searching') : t('tool.searched')"
    :suffix="getSearchQuery(part)"
    :streaming="isToolStreaming(part)"
    chevron="leading"
  >
    <Sources :sources="getSources(part)" />
  </UChatTool>
</template>
