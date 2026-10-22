<script setup lang="ts">
import type { FileWithStatus } from '@keundal/chat/file'
import { useElementBounding } from '@vueuse/core'

import type { ChatStatus } from '@keundal/chat/chat-message'
import type { DeliveryMode } from '../../composables/useKeundalChat'

const { t } = useLocale()

const props = withDefaults(
  defineProps<{
    status?: ChatStatus
    error?: Error
    files?: FileWithStatus[]
    uploading?: boolean
    disabled?: boolean
    /** Opens the file picker. */
    open: () => void
  }>(),
  {
    status: 'ready',
    error: undefined,
    files: () => []
  }
)

const emit = defineEmits<{
  submit: [event: Event]
  stop: []
  reload: []
  remove: [id: string]
}>()

const input = defineModel<string>({ default: '' })
/** 실행 중에 보낸 메시지를 대기열에 넣을지, 진행 중인 실행에 지시로 반영할지 정합니다. */
const delivery = defineModel<DeliveryMode>('delivery', { default: 'queue' })

const running = computed(() => props.status === 'submitted' || props.status === 'streaming')
const deliveryModes = computed(() => [
  { value: 'queue' as const, label: t('chat.deliveryQueue'), description: t('chat.deliveryQueueDescription'), icon: 'i-lucide-list-ordered' },
  { value: 'steer' as const, label: t('chat.deliverySteer'), description: t('chat.deliverySteerDescription'), icon: 'i-lucide-corner-down-right' }
])

const { $promptCatalog } = useNuxtApp()
const container = useTemplateRef('container')
const { top: promptTop } = useElementBounding(container)
const prompt = useTemplateRef('prompt')
const listId = useId()
const inputId = useId()
const cursor = ref(0)
const focused = ref(false)
const dismissed = ref<string>()
const selected = ref(0)
const loadingCommands = ref(false)
const commandsFailed = ref(false)
const dictation = ref<'idle' | 'recording' | 'transcribing'>('idle')
const commands = ref<{ name: string, description: string, kind: 'skill' | 'tool' }[]>([])
const slash = computed(() => /(?:^|\s)\/([^\s/]*)$/.exec(input.value.slice(0, cursor.value)))
const commandsOpen = computed(() => focused.value && !!slash.value && dismissed.value !== input.value
  && !props.disabled && !props.uploading && !props.error && props.status === 'ready' && dictation.value === 'idle')
const matches = computed(() => {
  const query = slash.value?.[1]?.toLocaleLowerCase() ?? ''
  return commands.value.filter(command => `${command.name} ${command.description}`.toLocaleLowerCase().includes(query))
})

function updateCursor() {
  cursor.value = prompt.value?.textareaRef?.selectionStart ?? input.value.length
}

watch(input, () => {
  dismissed.value = undefined
  nextTick(updateCursor)
})
watch(matches, () => {
  selected.value = 0
})
watch(selected, () => {
  nextTick(() => document.getElementById(`${listId}-${selected.value}`)?.scrollIntoView({ block: 'nearest' }))
})
watch(commandsOpen, async (open, _, onCleanup) => {
  if (!open) return
  const abort = new AbortController()
  onCleanup(() => abort.abort())
  loadingCommands.value = true
  commandsFailed.value = false
  commands.value = []
  try {
    const catalog = await $promptCatalog({ signal: abort.signal })
    if (abort.signal.aborted) return
    commands.value = [
      ...catalog.skills.map(skill => ({ ...skill, kind: 'skill' as const })),
      ...catalog.tools.filter(tool => tool.name.startsWith('mcp__')).map(tool => ({ ...tool, kind: 'tool' as const }))
    ].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
  } catch {
    if (!abort.signal.aborted) commandsFailed.value = true
  } finally {
    if (!abort.signal.aborted) loadingCommands.value = false
  }
})

async function selectCommand(index: number) {
  const command = matches.value[index]
  if (!command || !slash.value) return
  const start = cursor.value - slash.value[1]!.length - 1
  const end = cursor.value
  const text = `/${command.name} `
  input.value = input.value.slice(0, start) + text + input.value.slice(end)
  dismissed.value = input.value
  await nextTick()
  prompt.value?.textareaRef?.focus()
  prompt.value?.textareaRef?.setSelectionRange(start + text.length, start + text.length)
  updateCursor()
}

function onCommandKeydown(event: KeyboardEvent) {
  if (event.target !== prompt.value?.textareaRef || !commandsOpen.value || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    dismissed.value = input.value
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    event.stopPropagation()
    if (matches.value.length) selected.value = (selected.value + (event.key === 'ArrowDown' ? 1 : -1) + matches.value.length) % matches.value.length
  } else if ((event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) || (event.key === 'Tab' && !event.shiftKey && matches.value.length)) {
    event.preventDefault()
    event.stopPropagation()
    if (!loadingCommands.value && !commandsFailed.value) void selectCommand(selected.value)
  }
}

function onFocusOut(event: FocusEvent) {
  if (!container.value?.contains(event.relatedTarget as Node | null)) focused.value = false
}

const dictationPreview = ref('')
const placeholder = computed(() => {
  if (dictation.value === 'idle') return t('chat.prompt')
  return (
    dictationPreview.value || (dictation.value === 'recording' ? t('dictation.listening') : t('dictation.transcribing'))
  )
})

const canDictate = computed(
  () => dictation.value !== 'idle' || (props.status === 'ready' && !input.value.trim() && !props.files.length)
)

function appendTranscript(text: string) {
  input.value = input.value.trim() ? `${input.value.trimEnd()} ${text}` : text
}
</script>

<template>
  <div
    ref="container"
    class="relative"
    @keydown.capture="onCommandKeydown"
    @focusout="onFocusOut"
  >
    <label :for="inputId" class="sr-only">{{ t('chat.prompt') }}</label>
    <span role="status" class="sr-only">{{ commandsOpen && (loadingCommands || commandsFailed || !matches.length) ? t(loadingCommands ? 'prompt.commandsLoading' : commandsFailed ? 'prompt.commandsFailed' : 'prompt.commandsEmpty') : '' }}</span>
    <div
      v-if="commandsOpen"
      class="absolute inset-x-0 bottom-full z-20 mb-2 flex flex-col overflow-hidden rounded-lg border border-default bg-default p-1 shadow-lg"
      :style="{ maxHeight: `max(0px, calc(${promptTop}px - var(--ui-header-height) - 2rem))` }"
    >
      <div class="shrink-0 px-3 py-2 text-xs font-medium text-muted">
        {{ t('prompt.commands') }}
      </div>
      <div v-if="loadingCommands || commandsFailed || !matches.length" aria-hidden="true" class="px-3 py-3 text-sm text-muted">
        {{ t(loadingCommands ? 'prompt.commandsLoading' : commandsFailed ? 'prompt.commandsFailed' : 'prompt.commandsEmpty') }}
      </div>
      <div
        :id="listId"
        role="listbox"
        :aria-label="t('prompt.commands')"
        class="min-h-0 max-h-64 overflow-y-auto"
      >
        <button
          v-for="(command, index) in matches"
          :id="`${listId}-${index}`"
          :key="`${command.kind}:${command.name}`"
          type="button"
          role="option"
          tabindex="-1"
          :aria-selected="index === selected"
          class="flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-left"
          :class="index === selected ? 'bg-elevated' : 'hover:bg-elevated/50'"
          @pointermove="selected = index"
          @mousedown.prevent
          @click="selectCommand(index)"
        >
          <UIcon :name="command.kind === 'skill' ? 'i-lucide-book-open' : 'i-lucide-plug'" class="mt-0.5 size-4 shrink-0 text-muted" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-highlighted">/{{ command.name }}</span>
            <span class="line-clamp-2 block text-xs text-muted">{{ command.description }}</span>
          </span>
          <span class="shrink-0 text-xs text-muted">{{ command.kind === 'skill' ? t('skill.title') : 'MCP' }}</span>
        </button>
      </div>
    </div>
    <!-- Keep the native textbox role: a combobox role is invalid on textarea and hides the input from Windows UI Automation. -->
    <UChatPrompt
      ref="prompt"
      :id="inputId"
      name="prompt"
      :autofocus="false"
      v-model="input"
      :status="status"
      :error="error"
      :disabled="uploading || disabled"
      :placeholder="placeholder"
      :aria-label="t('chat.prompt')"
      aria-haspopup="listbox"
      :aria-controls="commandsOpen ? listId : undefined"
      :aria-activedescendant="commandsOpen && matches.length ? `${listId}-${selected}` : undefined"
      aria-autocomplete="list"
      color="neutral"
      variant="subtle"
      :ui="{ base: ['px-1.5', dictation !== 'idle' && 'placeholder:italic'], footer: 'gap-y-2' }"
      @focus="focused = true; updateCursor()"
      @click="updateCursor"
      @keyup="updateCursor"
      @select="updateCursor"
      @submit="emit('submit', $event)"
    >
      <template v-if="files.length > 0" #header>
        <ChatFiles :files="files" @remove="emit('remove', $event)" />
      </template>

      <template #footer>
        <ChatPromptMenu :open="open" />

        <div class="flex min-w-0 flex-wrap items-center justify-end gap-1 ms-auto">
          <ModelSelect />
          <ChatReasoningSelect />

          <UFieldGroup v-if="running" size="sm" :aria-label="t('chat.delivery')">
            <UTooltip v-for="mode in deliveryModes" :key="mode.value" :text="mode.description">
              <UButton
                :label="mode.label"
                :icon="mode.icon"
                color="neutral"
                :variant="delivery === mode.value ? 'solid' : 'outline'"
                :aria-pressed="delivery === mode.value"
                @click="delivery = mode.value"
              />
            </UTooltip>
          </UFieldGroup>
          <ChatDictateButton
            v-if="canDictate"
            v-model:state="dictation"
            v-model:preview="dictationPreview"
            :disabled="uploading || disabled"
            @transcript="appendTranscript"
          />
          <template v-else-if="running">
            <UButton
              icon="i-lucide-square"
              color="neutral"
              variant="ghost"
              size="sm"
              :aria-label="t('chat.stop')"
              @click="emit('stop')"
            />
            <UChatPromptSubmit
              status="ready"
              :disabled="uploading || disabled || !input.trim()"
              color="neutral"
              size="sm"
            />
          </template>
          <UChatPromptSubmit
            v-else
            :status="status"
            :disabled="uploading || disabled"
            color="neutral"
            size="sm"
            @stop="emit('stop')"
            @reload="emit('reload')"
          />
        </div>
      </template>
    </UChatPrompt>
  </div>
</template>
