<script setup lang="ts">
import { useChat } from '@ai-sdk/vue'
import { DefaultChatTransport } from 'ai'
import type { UIMessage } from 'ai'

const route = useRoute()
const toast = useToast()
const { model } = useModels()
const { webSearch, reasoning } = useChatSettings()
const { $chatStore } = useNuxtApp()

const { data } = await useAsyncData(`chat-${route.params.id}`, () => $chatStore.get(route.params.id as string), { server: false })

const isOwner = computed(() => data.value?.isOwner ?? false)
const visibility = ref<'public' | 'private'>(data.value?.visibility ?? 'private')
const title = ref<string | null>(data.value?.title ?? null)

watch(() => data.value?.title, (next) => {
  title.value = next ?? null
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

const votes = ref<NonNullable<typeof data.value>['votes']>([])

const input = ref('')

const { messages, status, error, sendMessage, regenerate, stop } = useChat({
  id: route.params.id as string,
  messages: data.value?.messages,
  transport: new DefaultChatTransport({
    fetch: async (_url, init) => $chatStore.respond(route.params.id as string, JSON.parse(init!.body as string), init?.signal ?? undefined),
    body: () => ({
      model: model.value,
      webSearch: webSearch.value,
      reasoning: reasoning.value
    })
  }),
  onData: async (dataPart) => {
    if (dataPart.type === 'data-chat-title') {
      await refreshNuxtData('chats')
      const chatsCache = useNuxtData<{ id: string, label: string }[]>('chats')
      const updated = chatsCache.data.value?.find(c => c.id === data.value!.id)
      if (updated && updated.label !== 'Untitled') {
        title.value = updated.label
      }
    }
  },
  onFinish: async () => {
    await refreshNuxtData('chats')
  },
  onError(error) {
    let message = error.message
    if (typeof message === 'string' && message[0] === '{') {
      try {
        message = JSON.parse(message).message || message
      } catch {
        // keep original message on malformed JSON
      }
    }

    toast.add({
      description: message,
      icon: 'i-lucide-alert-circle',
      color: 'error',
      duration: 0
    })
  }
})

async function handleSubmit(e: Event) {
  e.preventDefault()
  if (input.value.trim() && !uploading.value) {
    sendMessage({
      text: input.value,
      files: uploadedFiles.value.length > 0 ? uploadedFiles.value : undefined
    })
    input.value = ''
    clearFiles()
  }
}

const editingMessageId = ref<string | null>(null)

function startEdit(message: UIMessage) {
  if (editingMessageId.value) return

  editingMessageId.value = message.id
}

async function saveEdit(message: UIMessage, text: string) {
  try {
    await $chatStore.truncate(data.value!.id, message.id, 'edit')
  } catch {
    toast.add({ description: 'Failed to save edit.', icon: 'i-lucide-alert-circle', color: 'error' })
    return
  }

  editingMessageId.value = null
  sendMessage({ text, messageId: message.id })
}

async function regenerateMessage(message: UIMessage) {
  try {
    await $chatStore.truncate(data.value!.id, message.id, 'regenerate')
  } catch {
    toast.add({ description: 'Failed to regenerate.', icon: 'i-lucide-alert-circle', color: 'error' })
    return
  }

  regenerate({ messageId: message.id })
}

function getVote(messageId: string) {
  const vote = votes.value?.find(v => v.messageId === messageId)
  if (!vote) return null
  return !!vote.isUpvoted
}

async function vote(message: UIMessage, isUpvoted: boolean) {
  const snapshot = (votes.value ?? []).map(v => ({ ...v }))
  const toggling = getVote(message.id) === isUpvoted
  const next = toggling ? null : isUpvoted

  votes.value = next === null
    ? (votes.value ?? []).filter(v => v.messageId !== message.id)
    : [
        ...(votes.value ?? []).filter(v => v.messageId !== message.id),
        { chatId: data.value!.id, messageId: message.id, isUpvoted: next }
      ]

  try {
    await $chatStore.vote(data.value!.id, message.id, next ?? undefined)
  } catch {
    votes.value = snapshot
    toast.add({
      description: 'Failed to save vote',
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

let initialized = false
watch(data, async (chat) => {
  if (!chat || initialized) return
  initialized = true
  messages.value = chat.messages
  votes.value = chat.votes
  if (!chat.started && chat.messages.length === 1) await regenerate()
}, { immediate: true })

onBeforeUnmount(() => {
  void stop()
})
</script>

<template>
  <UDashboardPanel
    v-if="data?.id"
    id="chat"
    class="relative min-h-0"
    :ui="{ body: 'p-0 sm:p-0 overscroll-none' }"
  >
    <template #header>
      <Navbar>
        <template #title>
          <ChatTitle
            :chat-id="data!.id"
            :title="title"
            :is-owner="isOwner"
            @update:title="title = $event"
          />
        </template>

        <ChatVisibility
          v-if="isOwner"
          :chat-id="data!.id"
          :visibility="visibility"
          @update:visibility="visibility = $event"
        />
      </Navbar>
    </template>

    <template #body>
      <div ref="dropzoneRef" class="flex flex-1">
        <DragDropOverlay v-if="isOwner" :show="dragging" />

        <UContainer class="flex-1 flex flex-col gap-4 sm:gap-6">
          <UChatMessages
            should-auto-scroll
            :messages="messages"
            :status="status"
            :spacing-offset="isOwner ? 200 : 0"
            class="pt-(--ui-header-height) pb-4 sm:pb-6"
          >
            <template #indicator>
              <div class="flex items-center gap-1.5">
                <ChatIndicator />

                <UChatShimmer text="Thinking..." class="text-sm" />
              </div>
            </template>

            <template #files="{ message, parts }">
              <ChatFilePreview
                v-for="(part, index) in parts"
                :key="`${message.id}-${index}`"
                :name="part.filename || 'Attachment'"
                :type="part.mediaType"
                :preview-url="part.url"
                size="3xl"
              />
            </template>

            <template #content="{ message }">
              <ChatMessageContent
                :message="message"
                :editing="isOwner && editingMessageId === message.id"
                @save="saveEdit"
                @cancel-edit="editingMessageId = null"
              />
            </template>

            <template v-if="isOwner" #actions="{ message }">
              <ChatMessageActions
                :message="message"
                :streaming="status === 'streaming' && message.id === messages[messages.length - 1]?.id"
                :editing="editingMessageId === message.id"
                :vote="getVote(message.id)"
                @vote="(_message, isUpvoted) => vote(_message, isUpvoted)"
                @edit="startEdit"
                @regenerate="regenerateMessage"
              />
            </template>
          </UChatMessages>

          <ChatPrompt
            v-if="isOwner"
            v-model="input"
            :status="status"
            :error="error"
            :files="files"
            :uploading="uploading"
            :open="open"
            class="sticky bottom-0 [view-transition-name:chat-prompt] rounded-b-none z-10"
            @submit="handleSubmit"
            @stop="stop()"
            @reload="regenerate()"
            @remove="removeFile"
          />
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>

  <UContainer v-else class="flex-1 flex flex-col gap-4 sm:gap-6">
    <UError :error="{ statusMessage: 'Chat not found', statusCode: 404 }" class="min-h-full" />
  </UContainer>
</template>
