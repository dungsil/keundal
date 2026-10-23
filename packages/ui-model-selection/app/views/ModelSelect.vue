<script setup lang="ts">
import type { ModelOption } from '@keundal/chat/models'
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

const selected = computed({
  get: () => props.selectedModel.value,
  set: (value: string) => { props.selectedModel.value = value }
})
const current = computed(() => props.models.value.find(model => model.value === selected.value))
</script>

<template>
  <USelectMenu
    v-model="selected"
    :items="models.value"
    :aria-label="`${t('model.select')}: ${current?.label || selected}`"
    :loading="loading.value"
    :aria-busy="loading.value"
    :disabled="switching.value"
    size="sm"
    :icon="current?.icon"
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
          :loading="loading.value"
          @click.stop="refresh()"
        />
      </div>
    </template>
  </USelectMenu>
</template>
