<script setup lang="ts">
const { t } = useLocale()
const { reasoning, reasoningLevels } = useChatSettings()
const items = computed(() => reasoningLevels.value.map(value => ({ label: value, value })))
</script>

<template>
  <USelect
    v-if="reasoningLevels.length"
    v-model="reasoning"
    :items="items"
    :aria-label="t('prompt.reasoningLevel')"
    :content="{ 'aria-label': t('prompt.reasoningLevel') }"
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
