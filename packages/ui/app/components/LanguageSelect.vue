<script setup lang="ts">
const { locale, setLocale, t } = useLocale()

const items = [
  { label: 'English', value: 'en' },
  { label: '한국어', value: 'ko' }
]
</script>

<template>
  <USelect
    :model-value="locale"
    :items="items"
    :aria-label="t('language.label')"
    icon="i-lucide-languages"
    color="neutral"
    variant="ghost"
    size="sm"
    @update:model-value="setLocale"
  />
</template>
