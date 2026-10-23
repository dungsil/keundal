<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { Ref } from 'vue'

import { resolveModel } from '@keundal/chat/models'

import { useText } from '../locale'

const { t } = useText()

const props = defineProps<{
  open: () => void
  webSearch: Ref<boolean>
  model: Ref<string>
}>()

// Web search is a provider-defined tool, only available on Anthropic and OpenAI models.
const supportsWebSearch = computed(() => resolveModel(props.model.value).provider !== 'google')

defineShortcuts({
  meta_u: {
    usingInput: true,
    handler: () => {
      props.open()
    }
  }
})

const items = computed<DropdownMenuItem[][]>(() => [
  [
    {
      label: t('prompt.files'),
      icon: 'i-lucide-paperclip',
      kbds: ['meta', 'U'],
      onSelect: () => props.open()
    }
  ],
  [
    {
      label: t('prompt.search'),
      icon: 'i-lucide-globe',
      type: 'checkbox',
      checked: props.webSearch.value && supportsWebSearch.value,
      disabled: !supportsWebSearch.value,
      description: supportsWebSearch.value ? undefined : t('prompt.unsupported'),
      onUpdateChecked: (checked: boolean) => {
        props.webSearch.value = checked
      },
      onSelect: (e: Event) => e.preventDefault()
    }
  ]
])
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ side: 'top', align: 'start', alignOffset: -4 }"
    :ui="{ content: 'w-52' }"
    size="sm"
  >
    <UButton
      icon="i-lucide-plus"
      color="neutral"
      variant="ghost"
      size="sm"
      :aria-label="t('prompt.menu')"
      class="data-[state=open]:bg-elevated"
    />
  </UDropdownMenu>
</template>
