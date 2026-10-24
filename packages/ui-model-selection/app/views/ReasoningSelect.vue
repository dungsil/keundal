<script setup lang="ts">
import type { SelectProps } from '@nuxt/ui'
import { useMounted } from '@vueuse/core'
import type { AriaAttributes, Ref } from 'vue'

import { useText } from '../locale'

const { t } = useText()
// Browser preferences are loaded before hydration; render the control only after mounting.
const mounted = useMounted()

const props = defineProps<{
  reasoning: Ref<string>
  reasoningLevels: Ref<readonly string[]>
}>()

const selected = computed({
  get: () => props.reasoning.value,
  set: (value: string) => { props.reasoning.value = value }
})
// The translated label of each level; unknown values keep their raw name.
const levelKeys = {
  low: 'prompt.reasoningLevel.low',
  medium: 'prompt.reasoningLevel.medium',
  high: 'prompt.reasoningLevel.high',
  xhigh: 'prompt.reasoningLevel.xhigh',
  max: 'prompt.reasoningLevel.max'
} as const
const items = computed(() => props.reasoningLevels.value.map(value => ({
  label: t(levelKeys[value as keyof typeof levelKeys] ?? 'prompt.reasoningLevel'),
  value
})))
const content = computed<NonNullable<SelectProps['content']> & Pick<AriaAttributes, 'aria-label'>>(() => ({
  'aria-label': t('prompt.reasoningLevel')
}))
</script>

<template>
  <USelect
    v-if="mounted && reasoningLevels.value.length"
    v-model="selected"
    :items="items"
    :aria-label="t('prompt.reasoningLevel')"
    :content="content"
    :title="t('prompt.reasoningLevel')"
    icon="i-lucide-brain"
    size="sm"
    color="neutral"
    variant="ghost"
    value-key="value"
    class="data-[state=open]:bg-elevated"
    :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 motion-safe:transition-transform duration-200' }"
  />
</template>
