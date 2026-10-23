<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import { FALLBACK_MODEL, providerIcon } from '@keundal/llm-settings'
import { resolveModel } from '@keundal/chat/models'

const { t } = useLocale()

const { selectedModel, models, loading, switching, error, refresh } = useModels()
const mounted = useMounted()
// Browser preferences are loaded before hydration; keep the initial markup server-stable.
const fallback = resolveModel(FALLBACK_MODEL)
const displayedModels = computed(() => mounted.value ? models.value : [{
  value: fallback.value, label: fallback.id, icon: providerIcon(fallback.configuration)
}])
const displayedModel = computed({
  get: () => mounted.value ? selectedModel.value : fallback.value,
  set: (value: string) => { if (mounted.value) selectedModel.value = value }
})
</script>

<template>
  <USelectMenu
    v-model="displayedModel"
    :items="displayedModels"
    :aria-label="`${t('model.select')}: ${displayedModels.find(m => m.value === displayedModel)?.label || displayedModel}`"
    :loading="mounted && loading"
    :aria-busy="mounted && loading"
    :disabled="!mounted || switching"
    size="sm"
    :icon="displayedModels.find((m) => m.value === displayedModel)?.icon"
    color="neutral"
    variant="ghost"
    value-key="value"
    class="max-w-full data-[state=open]:bg-elevated"
    :ui="{
      content: 'w-80 max-w-[calc(100vw-2rem)]',
      itemLabel: 'text-clip whitespace-normal wrap-anywhere',
      trailingIcon: 'group-data-[state=open]:rotate-180 motion-safe:transition-transform duration-200'
    }"
    @update:open="
      (value) => {
        if (value) refresh(false)
      }
    "
  >
    <template #content-bottom>
      <div class="border-t border-default p-2 space-y-2 max-w-80">
        <p v-if="error" role="alert" tabindex="0" class="max-h-10 overflow-y-auto text-xs text-error break-words">
          {{ error }}
        </p>
        <p class="text-xs text-muted">
          {{ t('model.cache') }}
        </p>
        <UButton
          :label="t('model.refresh')"
          icon="i-lucide-refresh-cw"
          size="xs"
          color="neutral"
          variant="ghost"
          :loading="mounted && loading"
          @click.stop="refresh()"
        />
      </div>
    </template>
  </USelectMenu>
</template>
