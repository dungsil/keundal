<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'
import type { LocalChat } from '@keundal/chat/chat-store'
import type { AGUIEvent, ReasoningLevel } from '@keundal/core'
import type { ComposerOwner, DeliveryMode } from '@keundal/ui-composer/slots'
import type { ChatSummary } from '@keundal/ui-runtime'
import { SlotFactory, SlotOutlet } from '@keundal/ui-slots'
import { useElementSize } from '@vueuse/core'
import type { Ref } from 'vue'

import { useKeundalChat } from '../lib/use-keundal-chat'
import { useText } from '../locale'
import type { ChatObserverOwner } from '../slots'
import ChatIndicator from './ChatIndicator.vue'
import ChatQueue from './ChatQueue.vue'
import ChatSkeleton from './ChatSkeleton.vue'
import ChatTitle from './ChatTitle.vue'
import ChatVisibility from './ChatVisibility.vue'
import MessageActions from './message/MessageActions.vue'
import MessageContent from './message/MessageContent.vue'

const props = defineProps<{
  chatId: string
  model: Ref<string>
  titleModel: Ref<string>
  webSearch: Ref<boolean>
  reasoning: Ref<ReasoningLevel>
  chats: Ref<ChatSummary[] | undefined>
  ensureConfigured: (model: string) => boolean
  setPending: (pending: boolean) => void
  refreshChats: () => Promise<void>
  rename: (id: string, title: string) => Promise<void>
  remove: (id: string) => Promise<void>
  getChat: () => Promise<LocalChat | undefined>
  respond: (
    request: {
      messages: ChatMessage[]
      model: string
      titleModel?: string
      reasoning?: ReasoningLevel
      webSearch?: boolean
      onMessage?: (message: ChatMessage) => void
      onTitle?: (title: string) => void
    },
    signal?: AbortSignal
  ) => AsyncGenerator<AGUIEvent>
  steer: (message: ChatMessage) => Promise<boolean>
  enqueue: (message: ChatMessage) => Promise<ChatMessage[]>
  dequeue: (messageId: string) => Promise<ChatMessage[]>
  truncate: (messageId: string, type: 'edit' | 'regenerate') => Promise<void>
  branch: (messageId: string, newId: string) => Promise<LocalChat>
  saveVote: (messageId: string, isUpvoted?: boolean) => Promise<void>
  isBrowserOnly: () => boolean
}>()

const { t } = useText()
const prompt = useTemplateRef<HTMLDivElement>('prompt')
const { height: promptHeight } = useElementSize(prompt)

const toast = useToast()

const { data, status: loadStatus } = await useAsyncData(`chat-${props.chatId}`, () => props.getChat(), { server: false, lazy: true })

const loading = computed(() => loadStatus.value === 'idle' || loadStatus.value === 'pending')

watch(loadStatus, (value) => {
  props.setPending(value === 'pending' || value === 'idle')
}, { immediate: true, flush: 'sync' })
onUnmounted(() => {
  props.setPending(false)
})

const isOwner = computed(() => data.value?.isOwner ?? false)
const visibility = ref<'public' | 'private'>(data.value?.visibility ?? 'private')
const title = ref<string | null>(data.value?.title ?? null)
useHead(() => ({ title: title.value || t('chat.untitled') }))

watch(() => data.value?.title, (next) => {
  title.value = next ?? null
})

// A rename from the sidebar changes the list entry; the list never clears a title, so only a value is followed.
watch(() => props.chats.value?.find(chat => chat.id === props.chatId)?.title, (next) => {
  if (next) title.value = next
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

const input = useState(`chat-input-${props.chatId}`, () => '')
const delivery = ref<DeliveryMode>('queue')
const chatId = props.chatId

const observers = new Set<(event: AGUIEvent) => void>()
const observer = computed<ChatObserverOwner>(() => ({
  chatId,
  pendingRunId: data.value?.pendingRunId,
  subscribe(listener) {
    observers.add(listener)
    return () => {
      observers.delete(listener)
    }
  }
}))

const { messages, queue, status, error, sendMessage, regenerate, stop, resumeQueue, removeQueued } = useKeundalChat({
  respond: (messages, onMessage, signal) => props.respond({
    messages, model: props.model.value, titleModel: props.titleModel.value || undefined, webSearch: props.webSearch.value, reasoning: props.reasoning.value,
    onMessage,
    onTitle: (value) => {
      title.value = value
      void props.refreshChats()
    }
  }, signal),
  steer: message => props.steer(message),
  enqueue: message => props.enqueue(message),
  dequeue: messageId => props.dequeue(messageId),
  load: () => props.getChat(),
  onEvent(event) {
    for (const listener of observers) listener(event)
  },
  onFinish: async () => {
    await props.refreshChats()
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

async function handleSubmit(e: Event) {
  e.preventDefault()
  if (input.value.trim() && !uploading.value) {
    if (!props.ensureConfigured(props.model.value)) return
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

const composer = computed<ComposerOwner>(() => ({
  input: input.value,
  setInput: (value) => {
    input.value = value
  },
  status: status.value,
  error: error.value,
  files: files.value,
  uploading: uploading.value,
  openFiles: () => open(),
  removeFile,
  submit: handleSubmit,
  stop: () => void stop(),
  reload: () => void regenerate(),
  delivery: delivery.value,
  setDelivery: (mode) => {
    delivery.value = mode
  },
  variant: 'docked'
}))

const editingMessageId = ref<string | null>(null)
watch(editingMessageId, async (current, previous) => {
  if (current || !previous) return
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-message-edit="${CSS.escape(previous)}"]`)?.focus()
})

function startEdit(message: ChatMessage) {
  if (editingMessageId.value) return

  editingMessageId.value = message.id
}

async function saveEdit(message: ChatMessage, text: string) {
  try {
    await props.truncate(message.id, 'edit')
  } catch {
    toast.add({ description: t('chat.editFailed'), icon: 'i-lucide-alert-circle', color: 'error', duration: 0 })
    return
  }

  editingMessageId.value = null
  sendMessage({ text, messageId: message.id })
}

async function regenerateMessage(message: ChatMessage) {
  try {
    await props.truncate(message.id, 'regenerate')
  } catch {
    toast.add({ description: t('chat.regenerateFailed'), icon: 'i-lucide-alert-circle', color: 'error', duration: 0 })
    return
  }

  regenerate({ messageId: message.id })
}

async function branchMessage(message: ChatMessage) {
  try {
    const branched = await props.branch(message.id, crypto.randomUUID())
    await props.refreshChats()
    await navigateTo(`/chat/${branched.id}`)
  } catch {
    toast.add({ description: t('chat.branchFailed'), icon: 'i-lucide-alert-circle', color: 'error', duration: 0 })
  }
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
    await props.saveVote(message.id, next ?? undefined)
  } catch {
    votes.value = snapshot
    toast.add({
      description: t('chat.voteFailed'),
      icon: 'i-lucide-alert-circle',
      color: 'error',
      duration: 0
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
  <SlotOutlet name="chat.observer" :owner="observer" />

  <ChatSkeleton v-if="loading" />

  <UDashboardPanel
    v-else-if="data?.id"
    id="chat"
    class="relative min-h-0"
    :style="{ '--chat-prompt-height': `${promptHeight}px` }"
    :ui="{ body: 'p-0 sm:p-0 overscroll-none scroll-pt-(--ui-header-height) scroll-pb-(--chat-prompt-height)' }"
  >
    <template #header>
      <Navbar>
        <template #title>
          <ChatTitle
            :chat-id="data!.id"
            :title="title"
            :is-owner="isOwner"
            :rename="rename"
            :remove="remove"
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
            role="log"
            :aria-label="t('chat.messages')"
            :aria-busy="status === 'submitted' || status === 'streaming'"
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
              <SlotOutlet name="chat.indicator" :owner="{ chatId, messages, status }" />
            </template>

            <template #files="{ message, parts }">
              <FilePreview
                v-for="(part, index) in parts"
                :key="`${message.id}-${index}`"
                :name="part.filename || t('chat.attachment')"
                :type="part.mediaType"
                :preview-url="part.url"
                size="3xl"
              />
            </template>

            <template #content="{ message }">
              <MessageContent
                :message="message"
                :editing="isOwner && editingMessageId === message.id"
                @save="saveEdit"
                @cancel-edit="editingMessageId = null"
              />
              <SlotOutlet name="chat.message.footer" :owner="{ chatId, message, messages, status }" />
            </template>

            <template v-if="isOwner" #actions="{ message }">
              <MessageActions
                :message="message"
                :streaming="status === 'streaming' && message.id === messages[messages.length - 1]?.id"
                :editing="editingMessageId === message.id"
                :vote="getVote(message.id)"
                @vote="(_message, isUpvoted) => vote(_message, isUpvoted)"
                @edit="startEdit"
                @regenerate="regenerateMessage"
                @branch="branchMessage"
              />
            </template>
          </UChatMessages>

          <div v-if="isOwner" class="sticky bottom-0 z-10 flex flex-col gap-2 [view-transition-name:chat-prompt]">
            <ChatQueue
              :queue="queue"
              :paused="!running"
              :browser-only="isBrowserOnly()"
              @remove="removeQueuedMessage"
              @resume="resumeQueue()"
            />
            <div ref="prompt">
              <SlotFactory name="composer" :owner="composer" />
            </div>
          </div>
        </UContainer>
      </div>
    </template>
  </UDashboardPanel>

  <UContainer v-else class="flex-1 flex flex-col gap-4 sm:gap-6">
    <UError :error="{ statusMessage: t('chat.notFound'), statusCode: 404 }" class="min-h-full" />
  </UContainer>
</template>
