<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'
import type { ComposerOwner } from '@keundal/ui-composer/slots'
import { SlotFactory } from '@keundal/ui-slots'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  model: Ref<string>
  switching: Ref<boolean>
  ensureConfigured: (model: string) => boolean
  /** Create a conversation that starts with `message`. */
  create: (id: string, message: ChatMessage, model: string) => Promise<{ id: string }>
  refreshChats: () => Promise<void>
  applyDefaultModel: () => void
}>()

const { t } = useText()
useHead(() => ({ title: t('chat.new') }))

const input = useState('new-chat-input', () => '')
const loading = ref(false)
const chatId = crypto.randomUUID()

const {
  dropzoneRef,
  dragging,
  open,
  files,
  uploading,
  uploadedFiles,
  removeFile,
  clearFiles
} = useFileUploadWithStatus()

onMounted(() => props.applyDefaultModel())

async function createChat(prompt: string) {
  if (props.switching.value) return
  input.value = prompt
  if (!props.ensureConfigured(props.model.value)) return
  loading.value = true

  const parts: ChatMessage['parts'] = [{ type: 'text', text: prompt }]

  if (uploadedFiles.value.length > 0) {
    parts.push(...uploadedFiles.value)
  }

  try {
    const chat = await props.create(chatId, { id: crypto.randomUUID(), role: 'user', parts }, props.model.value)
    await props.refreshChats()
    input.value = ''
    await navigateTo(`/chat/${chat.id}`)
    return true
  } finally {
    loading.value = false
  }
}

async function onSubmit() {
  if (await createChat(input.value)) clearFiles()
}

const composer = computed<ComposerOwner>(() => ({
  threadId: chatId,
  input: input.value,
  setInput: (value) => { input.value = value },
  disabled: loading.value || props.switching.value,
  files: files.value,
  uploading: uploading.value,
  openFiles: open,
  removeFile,
  submit: onSubmit
}))

const quickChats = computed(() => [
  {
    label: t('suggestion.nuxt'),
    icon: 'i-logos-nuxt-icon'
  },
  {
    label: t('suggestion.vue'),
    icon: 'i-logos-vue'
  },
  {
    label: t('suggestion.unjs'),
    icon: 'i-logos-unjs'
  },
  {
    label: t('suggestion.vueuse'),
    icon: 'i-logos-vueuse'
  },
  {
    label: t('suggestion.tailwind'),
    icon: 'i-logos-tailwindcss-icon'
  },
  {
    label: t('suggestion.weather'),
    icon: 'i-lucide-sun'
  },
  {
    label: t('suggestion.chart'),
    icon: 'i-lucide-line-chart'
  }
])
</script>

<template>
  <UDashboardPanel
    id="home"
    class="min-h-0"
    :ui="{ body: 'px-0 pb-0 pt-(--ui-header-height) sm:px-0 sm:pb-0 sm:pt-(--ui-header-height) scroll-pt-(--ui-header-height)' }"
  >
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div ref="dropzoneRef" class="flex flex-1">
        <DragDropOverlay :show="dragging" />

        <UContainer class="flex-1 flex flex-col justify-center gap-4 pt-(--ui-header-height) pb-8">
          <h1 class="sr-only">{{ t('chat.new') }}</h1>

          <SlotFactory name="composer" :owner="composer" />

          <div class="flex flex-wrap gap-2">
            <UButton
              v-for="quickChat in quickChats"
              :key="quickChat.label"
              :icon="quickChat.icon"
              :label="quickChat.label"
              size="sm"
              color="neutral"
              variant="outline"
              class="rounded-full"
              :disabled="loading || switching.value"
              @click="createChat(quickChat.label)"
            />
          </div>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>
</template>
