<script setup lang="ts">
import { useChatPreferences } from '@keundal/ui/app/composables/useChatPreferences.ts'
import { useText } from '../locale'

const { t } = useText()
const { skipDeleteConfirmation, setSkipDeleteConfirmation } = useChatPreferences()
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
    <USwitch
      :model-value="skipDeleteConfirmation"
      :label="t('settings.skipDeleteConfirmation')"
      :aria-label="t('settings.skipDeleteConfirmation')"
      :description="t('settings.deleteWarning')"
      @update:model-value="setSkipDeleteConfirmation"
    />
  </section>
</template>
