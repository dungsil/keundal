<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'
import type { DeliveryMode } from '../../composables/useKeundalChat'
import { EventType, TRACE_EVENT, readTraceSpans } from '@keundal/core'
import type { TraceSpan } from '@keundal/core'
import { shallowRef } from 'vue'

const { t } = useLocale()

const route = useRoute()
const toast = useToast()
const { model, titleModel } = useModels()
const { webSearch, reasoning } = useChatSettings()
const { ensureConfigured } = useLLMSettings()
const { $chatStore } = useNuxtApp()

const { data, status: loadStatus } = await useAsyncData(`chat-${route.params.id}`, () => $chatStore.get(route.params.id as string), { server: false, lazy: true })

const loading = computed(() => loadStatus.value === 'idle' || loadStatus.value === 'pending')

useStartupPending('chat', loadStatus)

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

const input = useState(`chat-input-${route.params.id}`, () => '')
const delivery = ref<DeliveryMode>('queue')
const chatId = route.params.id as string
const activeTraceRunId = ref(data.value?.pendingRunId)
const liveTrace = shallowRef(new Map<string, TraceSpan>())
const liveTraceSpans = computed(() => [...liveTrace.value.values()])
let activeTraceId: string | undefined

const { messages, queue, status, error, sendMessage, regenerate, stop, resumeQueue, removeQueued } = useKeundalChat({
  respond: (messages, onMessage, signal) => $chatStore.respond(chatId, {
    messages, model: model.value, titleModel: titleModel.value || undefined, webSearch: webSearch.value, reasoning: reasoning.value,
    onMessage,
    onTitle: (value) => {
      title.value = value
      void refreshNuxtData('chats')
    }
  }, signal),
  steer: message => $chatStore.steer(chatId, message),
  enqueue: message => $chatStore.enqueue(chatId, message),
  dequeue: messageId => $chatStore.dequeue(chatId, messageId),
  load: () => $chatStore.get(chatId),
  onEvent(event) {
    if (event.type === EventType.RUN_STARTED) {
      activeTraceRunId.value = event.runId
      activeTraceId = undefined
      liveTrace.value = new Map()
    } else if (event.type === EventType.CUSTOM && event.name === TRACE_EVENT) {
      const span = readTraceSpans([event], undefined, 1)[0]
      if (!span) return
      if (span.runId === activeTraceRunId.value && span.kind === 'agent') activeTraceId = span.traceId
      if (span.traceId !== activeTraceId) return
      const updated = new Map(liveTrace.value)
      updated.delete(span.spanId)
      updated.set(span.spanId, span)
      while (updated.size > 200) updated.delete(updated.keys().next().value!)
      liveTrace.value = updated
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
      title: t('error.response'),
      description: message,
      icon: 'i-lucide-alert-circle',
      color: 'error',
      duration: 0
    })
  }
})
watch(() => data.value?.pendingRunId, (runId) => {
  if (runId) activeTraceRunId.value = runId
})
const showRootTrace = computed(() => !!activeTraceRunId.value && !messages.value.some(message => message.role === 'assistant' && message.id === activeTraceRunId.value && message.parts.length > 0))
const traceRunIds = computed(() => new Set(messages.value.filter(message => message.role === 'assistant').slice(-20).map(message => message.id)))

async function handleSubmit(e: Event) {
  e.preventDefault()
  if (input.value.trim() && !uploading.value) {
    if (!ensureConfigured(model.value)) return
    const text = input.value
    const attachments = uploadedFiles.value.length > 0 ? uploadedFiles.value : undefined
    input.value = ''
    clearFiles()
    try {
      await sendMessage({ text, files: attachments, mode: delivery.value })
    } catch {
      toast.add({ description: t('chat.queueFailed'), icon: 'i-lucide-alert-circle', color: 'error' })
    }
  }
}

async function removeQueuedMessage(messageId: string) {
  try {
    await removeQueued(messageId)
  } catch {
    toast.add({ description: t('chat.queueFailed'), icon: 'i-lucide-alert-circle', color: 'error' })
  }
}

const running = computed(() => status.value === 'submitted' || status.value === 'streaming')

const editingMessageId = ref<string | null>(null)

function startEdit(message: ChatMessage) {
  if (editingMessageId.value) return

  editingMessageId.value = message.id
}

async function saveEdit(message: ChatMessage, text: string) {
  try {
    await $chatStore.truncate(data.value!.id, message.id, 'edit')
  } catch {
    toast.add({ description: t('chat.editFailed'), icon: 'i-lucide-alert-circle', color: 'error' })
    return
  }

  editingMessageId.value = null
  sendMessage({ text, messageId: message.id })
}

async function regenerateMessage(message: ChatMessage) {
  try {
    await $chatStore.truncate(data.value!.id, message.id, 'regenerate')
  } catch {
    toast.add({ description: t('chat.regenerateFailed'), icon: 'i-lucide-alert-circle', color: 'error' })
    return
  }

  regenerate({ messageId: message.id })
}

function getVote(messageId: string) {
  const vote = votes.value?.find(v => v.messageId === messageId)
  if (!vote) return null
  return !!vote.isUpvoted
}

async function vote(message: ChatMessage, isUpvoted: boolean) {
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
      description: t('chat.voteFailed'),
      icon: 'i-lucide-alert-circle',
      color: 'error'
    })
  }
}

let initialized = false
watch(data, async (chat) => {
  if (!chat || initialized) return
  initialized = true
  visibility.value = chat.visibility
  messages.value = chat.messages
  queue.value = chat.queue ?? []
  votes.value = chat.votes
  if (!chat.started && chat.messages.length === 1) await regenerate()
}, { immediate: true })

onBeforeUnmount(() => {
  void stop()
})
</script>

<template>
  <ChatSkeleton v-if="loading" />

  <UDashboardPanel
    v-else-if="data?.id"
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

                <UChatShimmer :text="t('chat.thinking')" class="text-sm" />
              </div>
              <ChatTraceViewer v-if="showRootTrace" :run-id="activeTraceRunId!" :live="status === 'streaming'" :live-spans="liveTraceSpans" />
            </template>

            <template #files="{ message, parts }">
              <ChatFilePreview
                v-for="(part, index) in parts"
                :key="`${message.id}-${index}`"
                :name="part.filename || t('chat.attachment')"
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
              <ChatTraceViewer
                v-if="message.role === 'assistant' && traceRunIds.has(message.id)"
                :run-id="message.id"
                :live="status === 'streaming' && message.id === messages[messages.length - 1]?.id"
                :live-spans="message.id === activeTraceRunId ? liveTraceSpans : undefined"
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

          <div v-if="isOwner" class="sticky bottom-0 z-10 flex flex-col gap-2 [view-transition-name:chat-prompt]">
            <ChatQueue
              :queue="queue"
              :paused="!running"
              :browser-only="$chatStore.execution === 'browser'"
              @remove="removeQueuedMessage"
              @resume="resumeQueue()"
            />
            <ChatPrompt
              v-model="input"
              v-model:delivery="delivery"
              :status="status"
              :error="error"
              :files="files"
              :uploading="uploading"
              :open="open"
              class="rounded-b-none"
              @submit="handleSubmit"
              @stop="stop()"
              @reload="regenerate()"
              @remove="removeFile"
            />
          </div>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>

  <UContainer v-else class="flex-1 flex flex-col gap-4 sm:gap-6">
    <UError :error="{ statusMessage: t('chat.notFound'), statusCode: 404 }" class="min-h-full" />
  </UContainer>
</template>
