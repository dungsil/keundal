<script setup lang="ts">
const { t } = useLocale()
const { reasoning } = useChatSettings()

const selected = computed({
  get: () => reasoning.value ? 'on' : 'off',
  set: (value: string) => { reasoning.value = value === 'on' }
})

const items = computed(() => [
  { label: t('prompt.reasoningOn'), value: 'on' },
  { label: t('prompt.reasoningOff'), value: 'off' }
])
</script>

<template>
  <USelect
    v-model="selected"
    :items="items"
    :aria-label="t('prompt.reasoning')"
    icon="i-lucide-brain"
    size="sm"
    color="neutral"
    variant="ghost"
    value-key="value"
    class="data-[state=open]:bg-elevated"
    :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-200' }"
  />
</template>
