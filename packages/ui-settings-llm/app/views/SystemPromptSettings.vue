<script setup lang="ts">
import { useMounted } from '@vueuse/core'
import {
  assemblePrompt,
  parsePromptPresetSettings,
  type PromptBlock,
  type PromptPreset,
  type PromptPresetSettings
} from '@keundal/chat'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  promptPresets: Ref<PromptPresetSettings>
  savePromptPresets: (value: PromptPresetSettings) => void
}>()

const { t } = useText()
const mounted = useMounted()
const toast = useToast()
const draft = ref<PromptPresetSettings>({ activePresetId: null, presets: [] })
const selectedId = ref('')
const variableRows = ref<Record<string, { id: string, key: string, value: string }[]>>({})
const error = ref('')
const current = computed(() => draft.value.presets.find(preset => preset.id === selectedId.value))
const roles = ['system', 'user', 'assistant'] as const
const operators = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'] as const

function cloneBlock(block: PromptBlock): PromptBlock {
  return block.type === 'text' && block.condition
    ? { ...block, condition: { ...block.condition } }
    : { ...block }
}

function roleLabel(role: string) {
  return t(role === 'user' ? 'prompt.role.user' : role === 'assistant' ? 'prompt.role.assistant' : 'prompt.role.system')
}

onMounted(() => {
  const saved = props.promptPresets.value
  draft.value = {
    activePresetId: saved.activePresetId,
    presets: saved.presets.map(preset => ({
      ...preset,
      blocks: preset.blocks.map(cloneBlock),
      variables: { ...preset.variables }
    }))
  }
  for (const preset of draft.value.presets) {
    variableRows.value[preset.id] = Object.entries(preset.variables).map(([key, value]) => ({
      id: crypto.randomUUID(), key, value
    }))
  }
  selectedId.value = saved.activePresetId ?? saved.presets[0]?.id ?? ''
})

function createPreset() {
  const preset: PromptPreset = {
    id: crypto.randomUUID(),
    name: t('prompt.newPreset'),
    blocks: [
      { id: crypto.randomUUID(), type: 'text', name: t('prompt.textBlock'), enabled: true, role: 'system', content: '' },
      { id: crypto.randomUUID(), type: 'history', name: t('prompt.history'), enabled: true }
    ],
    variables: {}
  }
  draft.value.presets.push(preset)
  variableRows.value[preset.id] = []
  selectedId.value = preset.id
}

function duplicatePreset() {
  if (!current.value) return
  const source = current.value
  const id = crypto.randomUUID()
  draft.value.presets.push({
    ...source,
    id,
    name: t('prompt.copyName', { name: source.name }),
    blocks: source.blocks.map(block => ({ ...cloneBlock(block), id: crypto.randomUUID() })),
    variables: { ...source.variables }
  })
  variableRows.value[id] = (variableRows.value[source.id] ?? []).map(row => ({ ...row, id: crypto.randomUUID() }))
  selectedId.value = id
}

function deletePreset() {
  if (!current.value) return
  const id = current.value.id
  draft.value.presets = draft.value.presets.filter(preset => preset.id !== id)
  Reflect.deleteProperty(variableRows.value, id)
  if (draft.value.activePresetId === id) draft.value.activePresetId = null
  selectedId.value = draft.value.presets[0]?.id ?? ''
}

function addBlock() {
  current.value?.blocks.push({
    id: crypto.randomUUID(), type: 'text', name: t('prompt.textBlock'), enabled: true, role: 'system', content: ''
  })
}

function removeBlock(index: number) {
  if (current.value?.blocks[index]?.type === 'text') current.value.blocks.splice(index, 1)
}

function duplicateBlock(index: number) {
  const block = current.value?.blocks[index]
  if (block?.type !== 'text') return
  current.value!.blocks.splice(index + 1, 0, { ...cloneBlock(block), id: crypto.randomUUID() })
}

function setConditionVariable(block: PromptBlock, value: string | number) {
  if (block.type !== 'text') return
  const variable = String(value)
  if (!variable.trim()) Reflect.deleteProperty(block, 'condition')
  else block.condition = { variable, operator: block.condition?.operator ?? 'eq', value: block.condition?.value ?? '' }
}

function moveBlock(index: number, offset: number) {
  const blocks = current.value?.blocks
  if (!blocks || index + offset < 0 || index + offset >= blocks.length) return
  const [block] = blocks.splice(index, 1)
  if (block) blocks.splice(index + offset, 0, block)
}

function addVariable() {
  if (!current.value) return
  variableRows.value[current.value.id]!.push({ id: crypto.randomUUID(), key: '', value: '' })
}

function preparedPreset(preset: PromptPreset): PromptPreset {
  const rows = variableRows.value[preset.id] ?? []
  const keys = rows.map(row => row.key.trim())
  if (keys.some(key => !key)) throw new Error(t('prompt.variableKeyRequired'))
  if (keys.some(key => !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(key))) throw new Error(t('prompt.invalidVariableKey'))
  if (new Set(keys).size !== keys.length) throw new Error(t('prompt.duplicateVariables'))
  return { ...preset, variables: Object.fromEntries(rows.map((row, index) => [keys[index]!, row.value])) }
}

// A synthetic empty message marks history's position; no conversation is read or sent.
const historyPreviewId = 'keundal-prompt-history-preview'
function renderPreset(preset: PromptPreset) {
  try {
    return assemblePrompt([{ id: historyPreviewId, role: 'user', content: '' }], preset)
  } catch (cause) {
    const unknown = cause instanceof Error ? /^Unknown prompt variable: (.+)$/.exec(cause.message) : null
    throw new Error(unknown ? t('prompt.unknownVariable', { name: unknown[1]! }) : t('prompt.invalidPreset'))
  }
}

const preview = computed(() => {
  if (!current.value) return { messages: [], error: '' }
  try {
    return { messages: renderPreset(preparedPreset(current.value)), error: '' }
  } catch (cause) {
    return { messages: [], error: cause instanceof Error ? cause.message : t('prompt.invalidPreset') }
  }
})

function save() {
  error.value = ''
  const presets: PromptPreset[] = []
  for (const preset of draft.value.presets) {
    try {
      if (!preset.name.trim()) throw new Error(t('prompt.nameRequired'))
      const prepared = preparedPreset(preset)
      // Validate every preset, including inactive ones, so none can silently save broken references.
      renderPreset(prepared)
      presets.push(prepared)
    } catch (cause) {
      selectedId.value = preset.id
      error.value = cause instanceof Error ? cause.message : t('prompt.invalidPreset')
      return
    }
  }
  let next: PromptPresetSettings
  try {
    next = parsePromptPresetSettings({ activePresetId: draft.value.activePresetId, presets })
  } catch {
    error.value = t('prompt.invalidPreset')
    return
  }
  try {
    props.savePromptPresets(next)
    toast.add({ title: t('prompt.saved'), icon: 'i-lucide-check', color: 'success' })
  } catch {
    error.value = t('prompt.saveFailed')
  }
}
</script>

<template>
  <section class="space-y-4" aria-labelledby="system-prompt-settings-title">
    <h2 id="system-prompt-settings-title" class="text-lg font-semibold text-highlighted">
      {{ t('prompt.title') }}
    </h2>
    <form class="space-y-5" @submit.prevent="save">
      <fieldset :disabled="!mounted" class="min-w-0 space-y-5">
        <div class="space-y-2">
          <label for="prompt-active-preset" class="block text-sm font-medium text-highlighted">{{ t('prompt.activePreset') }}</label>
          <select id="prompt-active-preset" v-model="draft.activePresetId" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
            <option :value="null">{{ t('prompt.none') }}</option>
            <option v-for="preset in draft.presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
          </select>
        </div>
        <div class="space-y-2">
          <label for="prompt-edit-preset" class="block text-sm font-medium text-highlighted">{{ t('prompt.editPreset') }}</label>
          <select id="prompt-edit-preset" v-model="selectedId" :disabled="!draft.presets.length" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
            <option v-if="!draft.presets.length" value="">{{ t('prompt.noPresets') }}</option>
            <option v-for="preset in draft.presets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
          </select>
          <div class="flex flex-wrap gap-2">
            <UButton type="button" :label="t('prompt.createPreset')" icon="i-lucide-plus" color="neutral" variant="outline" @click="createPreset" />
            <UButton type="button" :label="t('prompt.duplicatePreset')" :disabled="!current" color="neutral" variant="outline" @click="duplicatePreset" />
            <UButton type="button" :label="t('prompt.deletePreset')" :disabled="!current" color="error" variant="ghost" @click="deletePreset" />
          </div>
        </div>
        <template v-if="current">
          <UFormField :label="t('prompt.presetName')" name="presetName">
            <UInput v-model="current.name" class="w-full" />
          </UFormField>
          <fieldset class="min-w-0 space-y-3">
            <legend class="text-sm font-medium text-highlighted">{{ t('prompt.blocks') }}</legend>
            <ol class="space-y-3">
              <li v-for="(block, index) in current.blocks" :key="block.id" class="min-w-0 space-y-3 rounded-lg border border-default p-3 sm:p-4">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <span class="text-sm font-medium">{{ index + 1 }}. {{ t(block.type === 'history' ? 'prompt.history' : 'prompt.textBlock') }}</span>
                  <div class="flex gap-1">
                    <UButton type="button" icon="i-lucide-arrow-up" :aria-label="t('prompt.moveUp', { index: index + 1 })" :disabled="index === 0" color="neutral" variant="ghost" @click="moveBlock(index, -1)" />
                    <UButton type="button" icon="i-lucide-arrow-down" :aria-label="t('prompt.moveDown', { index: index + 1 })" :disabled="index === current.blocks.length - 1" color="neutral" variant="ghost" @click="moveBlock(index, 1)" />
                    <UButton v-if="block.type === 'text'" type="button" icon="i-lucide-copy" :aria-label="t('prompt.duplicateBlock', { index: index + 1 })" color="neutral" variant="ghost" @click="duplicateBlock(index)" />
                    <UButton v-if="block.type === 'text'" type="button" icon="i-lucide-trash-2" :aria-label="t('prompt.removeBlock', { index: index + 1 })" color="error" variant="ghost" @click="removeBlock(index)" />
                  </div>
                </div>
                <UFormField :label="t('prompt.blockName')" :name="`block-name-${block.id}`">
                  <UInput v-model="block.name" class="w-full" />
                </UFormField>
                <USwitch v-model="block.enabled" :disabled="block.type === 'history'" :label="t('prompt.blockEnabled', { index: index + 1 })" />
                <template v-if="block.type === 'text'">
                  <div class="space-y-2">
                    <label :for="`prompt-role-${block.id}`" class="block text-sm font-medium text-highlighted">{{ t('prompt.role') }}</label>
                    <select :id="`prompt-role-${block.id}`" v-model="block.role" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
                      <option v-for="role in roles" :key="role" :value="role">{{ t(`prompt.role.${role}`) }}</option>
                    </select>
                  </div>
                  <UFormField :label="t('prompt.content')" :name="`block-content-${block.id}`">
                    <UTextarea v-model="block.content" :placeholder="t('prompt.placeholder')" :rows="5" class="w-full" />
                  </UFormField>
                  <div class="grid min-w-0 gap-3 sm:grid-cols-3">
                    <UFormField :label="t('prompt.conditionVariable')" :name="`condition-variable-${block.id}`">
                      <UInput :model-value="block.condition?.variable ?? ''" autocomplete="off" autocapitalize="off" :spellcheck="false" class="w-full" @update:model-value="setConditionVariable(block, $event)" />
                    </UFormField>
                    <template v-if="block.condition">
                      <div class="space-y-2">
                        <label :for="`prompt-condition-${block.id}`" class="block text-sm font-medium text-highlighted">{{ t('prompt.conditionOperator') }}</label>
                        <select :id="`prompt-condition-${block.id}`" v-model="block.condition.operator" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
                          <option v-for="operator in operators" :key="operator" :value="operator">{{ t(`prompt.operator.${operator}`) }}</option>
                        </select>
                      </div>
                      <UFormField :label="t('prompt.conditionValue')" :name="`condition-value-${block.id}`">
                        <UInput v-model="block.condition.value" class="w-full" />
                      </UFormField>
                    </template>
                  </div>
                </template>
              </li>
            </ol>
            <UButton type="button" :label="t('prompt.addBlock')" icon="i-lucide-plus" color="neutral" variant="outline" @click="addBlock" />
          </fieldset>
          <fieldset class="min-w-0 space-y-3">
            <legend class="text-sm font-medium text-highlighted">{{ t('prompt.variables') }}</legend>
            <p class="text-sm text-muted">{{ t('prompt.variableSyntax') }}</p>
            <div v-for="(row, index) in variableRows[current.id]" :key="row.id" class="flex flex-wrap items-start gap-2">
              <UInput v-model="row.key" :aria-label="t('prompt.variableKey', { index: index + 1 })" :placeholder="t('common.key')" autocomplete="off" autocapitalize="off" :spellcheck="false" class="min-w-0 flex-1 basis-32" />
              <UInput v-model="row.value" :aria-label="t('prompt.variableValue', { index: index + 1 })" :placeholder="t('common.value')" class="min-w-0 flex-1 basis-32" />
              <UButton type="button" icon="i-lucide-trash-2" :aria-label="t('prompt.removeVariable', { index: index + 1 })" color="neutral" variant="ghost" @click="variableRows[current.id]!.splice(index, 1)" />
            </div>
            <UButton type="button" :label="t('prompt.addVariable')" icon="i-lucide-plus" color="neutral" variant="outline" @click="addVariable" />
          </fieldset>
          <section class="space-y-3" aria-labelledby="prompt-preview-title">
            <h3 id="prompt-preview-title" class="text-sm font-medium text-highlighted">{{ t('prompt.preview') }}</h3>
            <p v-if="preview.error" role="alert" class="break-words text-sm text-error">{{ t('prompt.previewFailed') }} {{ preview.error }}</p>
            <ol v-else class="space-y-2">
              <li v-for="(message, index) in preview.messages" :key="index" class="min-w-0 rounded-lg border border-default p-3">
                <p v-if="message.id === historyPreviewId" class="text-sm text-muted">{{ t('prompt.historyPlaceholder') }}</p>
                <template v-else>
                  <p class="mb-1 text-xs font-medium text-muted">{{ roleLabel(message.role) }}</p>
                  <pre class="whitespace-pre-wrap break-words font-sans text-sm">{{ message.content }}</pre>
                </template>
              </li>
            </ol>
          </section>
        </template>
        <p v-if="error" role="alert" class="break-words text-sm text-error">{{ error }}</p>
        <div class="flex justify-end">
          <UButton type="submit" :disabled="!mounted" :label="t('common.save')" />
        </div>
      </fieldset>
    </form>
  </section>
</template>
