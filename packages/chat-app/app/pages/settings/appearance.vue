<script setup lang="ts">
const { t } = useLocale()
</script>

<template>
  <section class="mb-8 space-y-4" aria-labelledby="appearance-settings-title">
    <h2 id="appearance-settings-title" class="text-lg font-semibold text-highlighted">
      {{ t('settings.appearance') }}
    </h2>
    <div class="flex items-center justify-between gap-3">
      <span class="text-sm font-medium text-highlighted">{{ t('language.label') }}</span>
      <LanguageSelect />
    </div>
    <div class="flex items-center justify-between gap-3">
      <span class="text-sm font-medium text-highlighted">{{ t('settings.colorMode') }}</span>
      <UColorModeSwitch :aria-label="t('settings.colorMode')" />
    </div>
  </section>
</template>
