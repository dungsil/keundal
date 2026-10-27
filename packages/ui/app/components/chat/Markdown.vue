<script setup lang="ts">
import { SlotFactory } from '@keundal/ui-slots'

import type { MarkdownOwner } from '../../types/markdown'

const props = defineProps<MarkdownOwner>()
</script>

<template>
  <div>
    <SlotFactory name="markdown" :owner="props" />
  </div>
</template>
