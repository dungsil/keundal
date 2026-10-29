<script setup lang="ts">
import type { SkillSummary } from '@keundal/skill'
import type { ChatStatus } from '@keundal/chat/chat-message'
import type { FileWithStatus } from '@keundal/chat/file'
import { SlotOutlet } from '@keundal/ui-slots'
import { useElementBounding, useMediaQuery } from '@vueuse/core'
import type { Ref } from 'vue'

import { useText } from '../locale'
import type { DeliveryMode, DictationState } from '@keundal/ui/app/contracts/composer.ts'
import Files from './Files.vue'
import PromptMenu from './PromptMenu.vue'
import SubmitControls from './SubmitControls.vue'

const { t } = useText()

const props = withDefaults(
  defineProps<{
    threadId?: string
    input: string
    setInput: (value: string) => void
    status?: ChatStatus
    error?: Error
    disabled?: boolean
    files: FileWithStatus[]
    uploading: boolean
    openFiles: () => void
    removeFile: (id: string) => void
    submit: (event: Event) => void
    stop?: () => void
    reload?: () => void
    /** How a message sent during a run is delivered; chosen only where the page provides it. */
    delivery?: DeliveryMode
    setDelivery?: (mode: DeliveryMode) => void
    variant?: 'standalone' | 'docked'
    /** Skills and MCP tools that the prompt can name with `/`. */
    catalog: (options: { signal: AbortSignal }) => Promise<{ skills: readonly SkillSummary[]; tools: readonly SkillSummary[] }>
    webSearch: Ref<boolean>
    model: Ref<string>
  }>(),
  {
    status: 'ready',
    error: undefined,
    stop: undefined,
    reload: undefined,
    delivery: 'queue',
    setDelivery: undefined,
    variant: 'standalone'
  }
)

const running = computed(() => props.status === 'submitted' || props.status === 'streaming')
const busy = computed(() => props.uploading || props.disabled)
const touchInput = useMediaQuery('(pointer: coarse)')
const deliveryModes = computed(() => [
  { value: 'queue' as const, label: t('chat.deliveryQueue'), description: t('chat.deliveryQueueDescription'), icon: 'i-lucide-list-ordered' },
  { value: 'steer' as const, label: t('chat.deliverySteer'), description: t('chat.deliverySteerDescription'), icon: 'i-lucide-corner-down-right' }
])

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
const dictation = ref<DictationState>('idle')
const commands = ref<{ name: string, description: string, kind: 'skill' | 'tool' }[]>([])
const slash = computed(() => /(?:^|\s)\/([^\s/]*)$/.exec(props.input.slice(0, cursor.value)))
const commandsOpen = computed(() => focused.value && !!slash.value && dismissed.value !== props.input
  && !props.disabled && !props.uploading && !props.error && props.status === 'ready' && dictation.value === 'idle')
const matches = computed(() => {
  const query = slash.value?.[1]?.toLocaleLowerCase() ?? ''
  return commands.value.filter(command => `${command.name} ${command.description}`.toLocaleLowerCase().includes(query))
})

function updateCursor() {
  cursor.value = prompt.value?.textareaRef?.selectionStart ?? props.input.length
}

watch(() => props.input, () => {
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
    const catalog = await props.catalog({ signal: abort.signal })
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
  const next = props.input.slice(0, start) + text + props.input.slice(end)
  props.setInput(next)
  dismissed.value = next
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
    dismissed.value = props.input
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
  () => dictation.value !== 'idle' || (props.status === 'ready' && !props.input.trim() && !props.files.length)
)

const dictationOwner = computed(() => ({
  state: dictation.value,
  setState: (state: DictationState) => {
    dictation.value = state
  },
  setPreview: (text: string) => {
    dictationPreview.value = text
  },
  disabled: busy.value,
  appendTranscript: (text: string) => {
    props.setInput(props.input.trim() ? `${props.input.trimEnd()} ${text}` : text)
  }
}))
</script>

<template>
  <div
    ref="container"
    class="relative"
    :class="variant === 'docked' ? 'rounded-b-none' : '[view-transition-name:chat-prompt]'"
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
          class="group flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-md px-3 py-2 text-left"
          :class="index === selected ? 'bg-elevated' : 'hover:bg-elevated/50'"
          @pointermove="selected = index"
          @mousedown.prevent
          @click="selectCommand(index)"
        >
          <UIcon :name="command.kind === 'skill' ? 'i-lucide-book-open' : 'i-lucide-plug'" class="mt-0.5 size-4 shrink-0 text-muted" />
          <span class="min-w-0 flex-1">
            <span class="block truncate text-sm font-medium text-highlighted">/{{ command.name }}</span>
            <span class="line-clamp-2 block text-xs text-muted group-aria-selected:text-toned">{{ command.description }}</span>
          </span>
          <span class="sr-only">{{ command.kind === 'skill' ? t('skill.title') : 'MCP' }}</span>
        </button>
      </div>
    </div>
    <!-- Keep the native textbox role: a combobox role is invalid on textarea and hides the input from Windows UI Automation. -->
    <UChatPrompt
      ref="prompt"
      :id="inputId"
      name="prompt"
      :autofocus="false"
      :submit-on-enter="!touchInput"
      :maxrows="touchInput ? 6 : undefined"
      :model-value="input"
      :status="status"
      :error="error"
      :disabled="busy"
      :placeholder="placeholder"
      :aria-label="t('chat.prompt')"
      aria-haspopup="listbox"
      :aria-controls="commandsOpen ? listId : undefined"
      :aria-activedescendant="commandsOpen && matches.length ? `${listId}-${selected}` : undefined"
      aria-autocomplete="list"
      color="neutral"
      variant="subtle"
      :ui="{ root: 'outline-inverted', base: ['px-1.5', dictation !== 'idle' && 'placeholder:italic'], footer: 'gap-y-2' }"
      @update:model-value="setInput"
      @focus="focused = true; updateCursor()"
      @click="updateCursor"
      @keyup="updateCursor"
      @select="updateCursor"
      @submit="submit($event)"
    >
      <template v-if="files.length > 0" #header>
        <Files :files="files" @remove="removeFile" />
      </template>

      <template #footer>
        <PromptMenu :open="openFiles" :web-search="webSearch" :model="model" />

        <div class="flex min-w-0 flex-wrap items-center justify-end gap-1 ms-auto">
          <SlotOutlet name="composer.actions" :owner="{ threadId, disabled: busy, running }" />

          <UFieldGroup v-if="running" size="sm" :aria-label="t('chat.delivery')">
            <UTooltip v-for="mode in deliveryModes" :key="mode.value" :text="mode.description">
              <UButton
                :label="mode.label"
                :icon="mode.icon"
                color="neutral"
                :variant="delivery === mode.value ? 'solid' : 'outline'"
                :aria-pressed="delivery === mode.value"
                @click="setDelivery?.(mode.value)"
              />
            </UTooltip>
          </UFieldGroup>
          <SlotOutlet v-if="canDictate" name="composer.dictation" :owner="dictationOwner">
            <template #fallback>
              <SubmitControls
                :status="status"
                :running="running"
                :disabled="busy"
                :empty="!input.trim()"
                @stop="stop?.()"
                @reload="reload?.()"
              />
            </template>
          </SlotOutlet>
          <SubmitControls
            v-else
            :status="status"
            :running="running"
            :disabled="busy"
            :empty="!input.trim()"
            @stop="stop?.()"
            @reload="reload?.()"
          />
        </div>
      </template>
    </UChatPrompt>
  </div>
</template>

<style scoped>
/* The prompt form already indicates textarea focus; avoid a second outline inside it. */
:deep(textarea:focus-visible) {
  outline: none;
}
</style>
