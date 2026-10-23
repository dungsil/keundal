<script setup lang="ts">
import type { ChatMessage } from '@keundal/chat/chat-message'
import { useElementSize } from '@vueuse/core'
import type { DeliveryMode } from '../../composables/useKeundalChat'
import { EventType, TRACE_EVENT, readTraceSpans } from '@keundal/core'
import type { TraceSpan } from '@keundal/core'
import { shallowRef, useTemplateRef } from 'vue'
import { TRANSCRIPT_PAGE_SIZE, anchoredTranscriptStart, messageAnchor, messageIdFromHash, countToReveal, chatMarkdown } from '../../../shared/utils/chat-transcript'

const { t } = useLocale()
const chatPrompt = useTemplateRef('chatPrompt')
const { height: promptHeight } = useElementSize(() => chatPrompt.value?.$el)

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
useHead(() => ({ title: title.value || t('chat.untitled') }))

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
const visibleCount = ref(TRANSCRIPT_PAGE_SIZE)
const firstRevealedId = ref<string>()
const revealingHistory = ref(false)
const hiddenCount = computed(() => anchoredTranscriptStart(messages.value, visibleCount.value, firstRevealedId.value))
const visibleMessages = computed(() => messages.value.slice(hiddenCount.value))
const transcript = useTemplateRef('transcript')

async function loadOlder() {
  const first = visibleMessages.value[0]
  const anchor = first ? document.getElementById(messageAnchor(first.id)) : null
  const previousTop = anchor?.getBoundingClientRect().top
  let scroller = transcript.value?.parentElement ?? null
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
  revealingHistory.value = true
  visibleCount.value = messages.value.length - hiddenCount.value + TRANSCRIPT_PAGE_SIZE
  firstRevealedId.value = visibleMessages.value[0]?.id
  await nextTick()
  scroller ??= document.documentElement
  if (anchor && previousTop !== undefined) {
    scroller.scrollTop += anchor.getBoundingClientRect().top - previousTop
  }
  if (hiddenCount.value === 0) anchor?.focus({ preventScroll: true })
  revealingHistory.value = false
}

const linkedMessageExists = computed(() => messages.value.some(message => message.id === messageIdFromHash(route.hash)))
watch([() => route.hash, linkedMessageExists, loading], async ([hash]) => {
  const id = messageIdFromHash(hash)
  if (!id || !messages.value.some(message => message.id === id)) return
  revealingHistory.value = true
  visibleCount.value = countToReveal(messages.value, messages.value.length - hiddenCount.value, id)
  firstRevealedId.value = visibleMessages.value[0]?.id
  await nextTick()
  const target = document.getElementById(messageAnchor(id))
  target?.scrollIntoView({ block: 'start' })
  target?.focus({ preventScroll: true })
  revealingHistory.value = false
}, { immediate: true, flush: 'post' })

function exportMarkdown() {
  const blob = new Blob([chatMarkdown(title.value || t('chat.untitled'), messages.value)], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `chat-${chatId.replace(/[^a-zA-Z0-9_-]/g, '_')}.md`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

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
watch(editingMessageId, async (current, previous) => {
  if (current || !previous) return
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-message-edit="${CSS.escape(previous)}"]`)?.focus()
})

function startEdit(message: ChatMessage) {
  if (editingMessageId.value) return

  firstRevealedId.value = visibleMessages.value[0]?.id
  editingMessageId.value = message.id
}

async function saveEdit(message: ChatMessage, text: string) {
  try {
    await $chatStore.truncate(data.value!.id, message.id, 'edit')
  } catch {
    toast.add({ description: t('chat.editFailed'), icon: 'i-lucide-alert-circle', color: 'error', duration: 0 })
    return
  }

  editingMessageId.value = null
  sendMessage({ text, messageId: message.id })
}

async function regenerateMessage(message: ChatMessage) {
  try {
    await $chatStore.truncate(data.value!.id, message.id, 'regenerate')
  } catch {
    toast.add({ description: t('chat.regenerateFailed'), icon: 'i-lucide-alert-circle', color: 'error', duration: 0 })
    return
  }

  regenerate({ messageId: message.id })
}

async function branchMessage(message: ChatMessage) {
  try {
    const branched = await $chatStore.branch(data.value!.id, message.id, crypto.randomUUID())
    await refreshNuxtData('chats')
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
    await $chatStore.vote(data.value!.id, message.id, next ?? undefined)
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
            @update:title="title = $event"
          />
        </template>

        <UButton
          icon="i-lucide-download"
          color="neutral"
          variant="ghost"
          :aria-label="t('chat.exportMarkdown')"
          :title="t('chat.exportMarkdown')"
          @click="exportMarkdown"
        />
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
          <div ref="transcript" class="flex flex-1 flex-col pt-(--ui-header-height)">
            <UButton
              v-if="hiddenCount > 0"
              class="my-4 self-start scroll-mt-[calc(var(--ui-header-height)+1rem)]"
              variant="outline"
              color="neutral"
              :label="t('chat.loadOlder', { count: hiddenCount })"
              @click="loadOlder"
            />
            <UChatMessages
              role="log"
              :aria-label="t('chat.messages')"
              :aria-busy="status === 'submitted' || status === 'streaming'"
              :auto-scroll="{ label: t('chat.scrollToBottom'), square: true, ui: { label: 'sr-only' } }"
              :should-auto-scroll="!revealingHistory"
              :should-scroll-to-bottom="!messageIdFromHash(route.hash)"
              :messages="visibleMessages"
              :status="status"
              :spacing-offset="isOwner ? 200 : 0"
              class="pb-4 sm:pb-6"
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
                <div :id="messageAnchor(message.id)" tabindex="-1" class="scroll-mt-20 outline-none focus-visible:ring-2 focus-visible:ring-primary">
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
                </div>
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
                  @branch="branchMessage"
                />
              </template>
            </UChatMessages>
          </div>

          <div v-if="isOwner" class="sticky bottom-0 z-10 flex flex-col gap-2 [view-transition-name:chat-prompt]">
            <ChatQueue
              :queue="queue"
              :paused="!running"
              :browser-only="$chatStore.execution === 'browser'"
              @remove="removeQueuedMessage"
              @resume="resumeQueue()"
            />
            <ChatPrompt
              ref="chatPrompt"
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
