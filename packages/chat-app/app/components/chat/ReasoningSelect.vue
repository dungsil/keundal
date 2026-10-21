<script setup lang="ts">
const { t } = useLocale()
const { reasoning, reasoningLevels } = useChatSettings()
const items = computed(() => reasoningLevels.value.map(value => ({ label: value, value })))
</script>

<template>
  <USelect
    v-model="reasoning"
    :items="items"
    :aria-label="t('prompt.reasoningLevel')"
    :disabled="!reasoningLevels.length"
    :title="reasoningLevels.length ? t('prompt.reasoningLevel') : t('prompt.unsupported')"
    icon="i-lucide-brain"
    size="sm"
    color="neutral"
    variant="ghost"
    value-key="value"
    class="data-[state=open]:bg-elevated"
    :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-200' }"
  />
</template>
