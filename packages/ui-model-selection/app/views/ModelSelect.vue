<script setup lang="ts">
import { resolveModel, type ModelOption } from '@keundal/chat/models'
import { FALLBACK_MODEL, providerIcon } from '@keundal/llm-settings'
import { useMounted } from '@vueuse/core'
import type { Ref } from 'vue'

import { useText } from '../locale'

const { t } = useText()

const props = defineProps<{
  selectedModel: Ref<string>
  models: Ref<ModelOption[]>
  loading: Ref<boolean>
  switching: Ref<boolean>
  error: Ref<string>
  refresh: (force?: boolean) => Promise<void>
}>()

const mounted = useMounted()
// Browser preferences are loaded before hydration; keep the initial markup server-stable.
const fallback = resolveModel(FALLBACK_MODEL)
const displayedModels = computed(() => mounted.value ? props.models.value : [{
  value: fallback.value, label: fallback.id, icon: providerIcon(fallback.configuration)
}])
const selected = computed({
  get: () => mounted.value ? props.selectedModel.value : fallback.value,
  set: (value: string) => { if (mounted.value) props.selectedModel.value = value }
})
const current = computed(() => displayedModels.value.find(model => model.value === selected.value))
</script>

<template>
  <USelectMenu
    v-model="selected"
    :items="displayedModels"
    :aria-label="`${t('model.select')}: ${current?.label || selected}`"
    :loading="mounted && loading.value"
    :aria-busy="mounted && loading.value"
    :disabled="!mounted || switching.value"
    size="sm"
    :icon="current?.icon"
    color="neutral"
    variant="ghost"
    value-key="value"
    class="min-w-0 max-w-full data-[state=open]:bg-elevated"
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
        <p v-if="error.value" role="alert" tabindex="0" class="max-h-10 overflow-y-auto text-xs text-error break-words">
          {{ error.value }}
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
          :loading="mounted && loading.value"
          @click.stop="refresh()"
        />
      </div>
    </template>
  </USelectMenu>
</template>
