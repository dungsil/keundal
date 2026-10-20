<script setup lang="ts">
import type { ChatMessage } from '../../shared/utils/chat-message'

const { t } = useLocale()

const input = ref('')
const loading = ref(false)
const chatId = crypto.randomUUID()

const greeting = computed(() => {
  const hour = new Date().getHours()
  let timeGreeting = t('greeting.evening')
  if (hour < 12) timeGreeting = t('greeting.morning')
  else if (hour < 18) timeGreeting = t('greeting.afternoon')

  return timeGreeting
})

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

const { $chatStore } = useNuxtApp()
const { model } = useModels()
const { ensureConfigured } = useLLMSettings()

async function createChat(prompt: string) {
  input.value = prompt
  if (!ensureConfigured(model.value)) return
  loading.value = true

  const parts: ChatMessage['parts'] = [{ type: 'text', text: prompt }]

  if (uploadedFiles.value.length > 0) {
    parts.push(...uploadedFiles.value)
  }

  try {
    const chat = await $chatStore.create(chatId, { id: crypto.randomUUID(), role: 'user', parts }, model.value)
    await refreshNuxtData('chats')
    await navigateTo(`/chat/${chat.id}`)
    return true
  } finally {
    loading.value = false
  }
}

async function onSubmit() {
  if (await createChat(input.value)) clearFiles()
}

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
    :ui="{ body: 'p-0 sm:p-0' }"
  >
    <template #header>
      <Navbar />
    </template>

    <template #body>
      <div ref="dropzoneRef" class="flex flex-1">
        <DragDropOverlay :show="dragging" />

        <UContainer class="flex-1 flex flex-col justify-center gap-4 sm:gap-6 py-8">
          <h1 class="text-3xl sm:text-4xl text-highlighted font-bold">
            {{ greeting }}
          </h1>

          <ChatPrompt
            v-model="input"
            :disabled="loading"
            :files="files"
            :uploading="uploading"
            :open="open"
            class="[view-transition-name:chat-prompt]"
            @submit="onSubmit"
            @remove="removeFile"
          />

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
              @click="createChat(quickChat.label)"
            />
          </div>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>
</template>
