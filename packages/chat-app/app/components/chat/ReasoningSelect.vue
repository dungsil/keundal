<script setup lang="ts">
import type { SelectProps } from '@nuxt/ui'
import type { AriaAttributes } from 'vue'

const { t } = useLocale()
const { reasoning, reasoningLevels } = useChatSettings()
const items = computed(() => reasoningLevels.value.map((value) => ({ label: value, value })))
const content = computed<NonNullable<SelectProps['content']> & Pick<AriaAttributes, 'aria-label'>>(() => ({
  'aria-label': t('prompt.reasoningLevel')
}))
</script>

<template>
  <USelect
    v-if="reasoningLevels.length"
    v-model="reasoning"
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
