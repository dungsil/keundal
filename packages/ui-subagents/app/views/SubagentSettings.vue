<script setup lang="ts">
import type { SubagentRole } from '@keundal/subagent'
import type { ModelOption } from '@keundal/chat/models'
import { useMounted } from '@vueuse/core'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  subagentRoles: Ref<SubagentRole[]>
  saveSubagentRoles: (value: readonly SubagentRole[]) => void
  models: Ref<ModelOption[]>
}>()

interface RoleDraft extends Omit<SubagentRole, 'maxToolRounds'> {
  id: number
  name: string
  description: string
  instructions: string
  model?: string
  toolPolicy: 'inherit' | 'none' | 'custom'
  toolsText: string
  maxToolRounds: string | number
}

type FieldErrors = Partial<Record<'name' | 'description' | 'instructions' | 'maxToolRounds', string>>

const { t } = useText()
const mounted = useMounted()
const toast = useToast()
const drafts = ref<RoleDraft[]>([])
const fieldErrors = ref<Record<number, FieldErrors>>({})
const error = ref('')
let nextId = 0

function loadDrafts() {
  drafts.value = props.subagentRoles.value.map(role => ({
    ...role,
    id: nextId++,
    maxToolRounds: role.maxToolRounds ?? '',
    toolPolicy: role.allowedTools === undefined ? 'inherit' : role.allowedTools.length ? 'custom' : 'none',
    toolsText: role.allowedTools?.join('\n') ?? ''
  }))
}

onMounted(loadDrafts)

function modelOptions(value?: string) {
  const items = [...props.models.value]
  if (value && !items.some(item => item.value === value)) items.unshift({ value, label: value, icon: 'i-lucide-bot' })
  return items
}

function addRole() {
  if (!mounted.value || drafts.value.length >= 32) return
  drafts.value.push({ id: nextId++, name: '', description: '', instructions: '', toolPolicy: 'inherit', toolsText: '', maxToolRounds: '' })
}

function removeRole(id: number) {
  drafts.value = drafts.value.filter(role => role.id !== id)
  delete fieldErrors.value[id]
}

function save() {
  if (!mounted.value) return
  error.value = ''
  fieldErrors.value = {}
  if (drafts.value.length > 32) {
    error.value = t('subagents.tooManyRoles')
    return
  }

  const roles = drafts.value.map(role => ({
    name: role.name.trim(),
    description: role.description.trim(),
    instructions: role.instructions.trim(),
    ...(role.model?.trim() ? { model: role.model.trim() } : {}),
    ...(role.toolPolicy === 'inherit' ? {} : {
      allowedTools: role.toolPolicy === 'none' ? [] : [...new Set(role.toolsText.split(/[\s,]+/).filter(Boolean))]
    }),
    ...(role.maxToolRounds === '' ? {} : { maxToolRounds: Number(role.maxToolRounds) })
  }))
  const names = new Set<string>()
  const duplicates = new Set<string>()
  for (const role of roles) {
    if (names.has(role.name)) duplicates.add(role.name)
    names.add(role.name)
  }

  roles.forEach((role, index) => {
    const errors: FieldErrors = {}
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(role.name)) {
      errors.name = t('subagents.invalidName')
    } else if (duplicates.has(role.name)) {
      errors.name = t('subagents.duplicateName')
    }
    if (!role.description || role.description.length > 500) {
      errors.description = t('subagents.invalidDescription')
    }
    if (!role.instructions || role.instructions.length > 20000) {
      errors.instructions = t('subagents.invalidInstructions')
    }
    if (role.maxToolRounds !== undefined && (!Number.isSafeInteger(role.maxToolRounds) || role.maxToolRounds <= 0)) {
      errors.maxToolRounds = t('subagents.invalidMaxToolRounds')
    }
    if (Object.keys(errors).length) fieldErrors.value[drafts.value[index]!.id] = errors
  })
  if (Object.keys(fieldErrors.value).length) return

  try {
    props.saveSubagentRoles(roles)
    loadDrafts()
    toast.add({ title: t('subagents.saved'), icon: 'i-lucide-check', color: 'success' })
  } catch {
    error.value = t('subagents.saveFailed')
  }
}
</script>

<template>
  <section class="space-y-4" aria-labelledby="subagent-settings-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="subagent-settings-title" class="text-lg font-semibold text-highlighted">
        {{ t('subagents.title') }}
      </h2>
      <UButton
        type="button"
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        :label="t('subagents.addRole')"
        :disabled="!mounted || drafts.length >= 32"
        @click="addRole"
      />
    </div>
    <form class="space-y-4" @submit.prevent="save">
      <p v-if="!drafts.length" class="rounded-lg border border-default p-4 text-sm text-muted">
        {{ t('subagents.empty') }}
      </p>
      <fieldset
        v-for="(role, index) in drafts"
        :key="role.id"
        :disabled="!mounted"
        :aria-label="t('subagents.role', { index: index + 1 })"
        class="min-w-0 space-y-4 rounded-lg border border-default p-4"
      >
        <div class="flex items-center justify-between gap-3">
          <h3 class="font-medium text-highlighted">{{ t('subagents.role', { index: index + 1 }) }}</h3>
          <UButton
            type="button"
            icon="i-lucide-trash-2"
            color="error"
            variant="ghost"
            :label="t('subagents.remove')"
            :aria-label="t('subagents.removeRole', { index: index + 1 })"
            @click="removeRole(role.id)"
          />
        </div>
        <UFormField :label="t('subagents.name')" :name="`roles.${role.id}.name`" :error="fieldErrors[role.id]?.name">
          <UInput v-model="role.name" class="w-full" />
        </UFormField>
        <UFormField :label="t('subagents.description')" :name="`roles.${role.id}.description`" :error="fieldErrors[role.id]?.description">
          <UTextarea v-model="role.description" :rows="2" class="w-full" />
        </UFormField>
        <UFormField :label="t('subagents.instructions')" :name="`roles.${role.id}.instructions`" :error="fieldErrors[role.id]?.instructions">
          <UTextarea v-model="role.instructions" :rows="6" class="w-full" />
        </UFormField>
        <UFormField :label="t('subagents.model')" :name="`roles.${role.id}.model`">
          <select v-model="role.model" :aria-label="t('subagents.model')" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
            <option :value="undefined">{{ t('subagents.inherit') }}</option>
            <option v-for="model in modelOptions(role.model)" :key="model.value" :value="model.value">{{ model.label }}</option>
          </select>
        </UFormField>
        <UFormField :label="t('subagents.tools')" :name="`roles.${role.id}.tools`">
          <select v-model="role.toolPolicy" :aria-label="t('subagents.tools')" class="w-full rounded-md border border-default bg-default px-3 py-2 text-sm">
            <option value="inherit">{{ t('subagents.inherit') }}</option>
            <option value="none">{{ t('subagents.noTools') }}</option>
            <option value="custom">{{ t('subagents.customTools') }}</option>
          </select>
        </UFormField>
        <UFormField v-if="role.toolPolicy === 'custom'" :label="t('subagents.allowedTools')" :name="`roles.${role.id}.allowedTools`">
          <UTextarea v-model="role.toolsText" :rows="3" :placeholder="t('subagents.toolsPlaceholder')" class="w-full" />
          <p class="mt-2 text-sm text-muted">{{ t('subagents.deferredTools') }}</p>
        </UFormField>
        <UFormField :label="t('subagents.maxToolRounds')" :name="`roles.${role.id}.maxToolRounds`" :error="fieldErrors[role.id]?.maxToolRounds">
          <UInput v-model.number="role.maxToolRounds" type="number" :min="1" :max="Number.MAX_SAFE_INTEGER" :step="1" :placeholder="t('subagents.inherit')" class="w-full" />
        </UFormField>
      </fieldset>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <div class="flex justify-end">
        <UButton type="submit" :disabled="!mounted" :label="t('common.save')" />
      </div>
    </form>
  </section>
</template>
