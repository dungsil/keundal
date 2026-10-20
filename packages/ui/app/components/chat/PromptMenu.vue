<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'

const { t } = useLocale()

const props = defineProps<{
  open: () => void
}>()

const { model } = useModels()
const { webSearch, reasoning } = useChatSettings()

// Web search is a provider-defined tool, only available on Anthropic and OpenAI models.
const supportsWebSearch = computed(() => !model.value.startsWith('google/'))

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
      checked: webSearch.value && supportsWebSearch.value,
      disabled: !supportsWebSearch.value,
      description: supportsWebSearch.value ? undefined : t('prompt.unsupported'),
      onUpdateChecked: (checked: boolean) => {
        webSearch.value = checked
      },
      onSelect: (e: Event) => e.preventDefault()
    },
    {
      label: t('prompt.reasoning'),
      icon: 'i-lucide-brain',
      type: 'checkbox',
      checked: reasoning.value,
      onUpdateChecked: (checked: boolean) => {
        reasoning.value = checked
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
