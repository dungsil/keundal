<script setup lang="ts">
import { importSkillFile } from '../../shared/utils/skill-import'

import { managedSkillSchema, type LocalSkillFile, type ManagedSkill, type SkillSettings } from '@keundal/chat/skills'

const { t } = useLocale()

const { $skillManager } = useNuxtApp()
const localSkills = useRuntimeConfig().public.chatCapabilities.localSkills
const settings = ref<SkillSettings>({ skills: [], disabledFiles: [], loadLocal: true })
const files = ref<LocalSkillFile[]>([])
const roots = ref<string[]>([])
const error = ref('')
const fileError = ref('')
const loading = ref(false)
const editing = ref(false)
const originalName = ref<string | null>(null)
const selectedFile = ref<LocalSkillFile | null>(null)
const deleting = ref(false)
const importInput = ref<HTMLInputElement | null>(null)
const blank = (): ManagedSkill => ({ name: '', description: '', content: '', enabled: true })
function backToSkills() {
  editing.value = false
  error.value = ''
}
const draft = ref(blank())

async function refreshFiles() {
  loading.value = true
  fileError.value = ''
  try {
    const result = await $skillManager.listFiles()
    files.value = result.files
    roots.value = result.roots
  } catch (cause) {
    files.value = []
    fileError.value = String(cause instanceof Error ? cause.message : cause)
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  error.value = ''
  editing.value = false
  try {
    settings.value = $skillManager.load()
  } catch {
    error.value = t('skill.readFailed')
  }
  if (localSkills) await refreshFiles()
})

function persist(next: SkillSettings) {
  try {
    settings.value = $skillManager.save(next)
    error.value = ''
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('skill.saveFailed')
    return false
  }
}

function edit(skill?: ManagedSkill, file?: LocalSkillFile) {
  error.value = ''
  deleting.value = false
  originalName.value = skill?.name ?? null
  selectedFile.value = file ?? null
  draft.value = skill
    ? { ...skill }
    : file?.definition
      ? { ...file.definition, enabled: !settings.value.disabledFiles.includes(file.path) }
      : blank()
  editing.value = true
}

function save() {
  if (selectedFile.value) return
  const parsed = managedSkillSchema.safeParse(draft.value)
  if (!parsed.success) {
    const field = parsed.error.issues[0]!.path[0]
    error.value = t(field === 'name' ? 'skill.invalidName' : field === 'description' ? 'skill.descriptionRequired' : 'skill.instructionsRequired')
    return
  }
  if (settings.value.skills.some(skill => skill.name === parsed.data.name && skill.name !== originalName.value)) {
    error.value = t('skill.duplicate', { name: parsed.data.name })
    return
  }
  const skills = settings.value.skills.filter(skill => skill.name !== originalName.value)
  if (persist({ ...settings.value, skills: [...skills, parsed.data].sort((a, b) => a.name.localeCompare(b.name)) }))
    editing.value = false
}

function remove() {
  if (
    persist({ ...settings.value, skills: settings.value.skills.filter(skill => skill.name !== originalName.value) })
  )
    editing.value = false
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const definition = await importSkillFile(file)
    edit()
    draft.value = { ...definition, enabled: true }
  } catch (cause) {
    error.value = `${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    input.value = ''
  }
}

function toggleFile(path: string, enabled: boolean) {
  const disabledFiles = settings.value.disabledFiles.filter(file => file !== path)
  if (!enabled) disabledFiles.push(path)
  persist({ ...settings.value, disabledFiles })
}
</script>

<template>
  <section class="space-y-6" aria-labelledby="skill-settings-title">
    <div class="space-y-2">
      <h2 id="skill-settings-title" class="text-lg font-semibold text-highlighted">
        {{ t('skill.title') }}
      </h2>
      <p class="text-sm text-muted">
        {{ t('skill.description') }}
      </p>
    </div>
    <div class="space-y-5">
      <UAlert
        color="neutral"
        variant="subtle"
        icon="i-lucide-info"
        :title="t('skill.noticeTitle')"
        :description="t('skill.notice')"
      />

      <template v-if="editing">
        <div class="flex items-center justify-between gap-3">
          <UButton
            :label="t('skill.back')"
            icon="i-lucide-arrow-left"
            variant="ghost"
            color="neutral"
            @click="backToSkills"
          />
          <UBadge
            v-if="selectedFile"
            :label="t('skill.readOnly')"
            variant="subtle"
            color="neutral"
          />
          <span v-else class="text-sm text-muted">{{ originalName ? t('skill.edit') : t('skill.new') }}</span>
        </div>
        <p v-if="selectedFile" class="text-xs text-muted break-all">
          {{ selectedFile.path }}
        </p>
        <form id="skill-editor" class="space-y-4" @submit.prevent="save">
          <UFormField :label="t('common.name')" name="skill-name" :description="t('skill.nameDescription')">
            <UInput
              id="skill-name"
              v-model="draft.name"
              :aria-label="t('skill.nameLabel')"
              placeholder="code-review"
              class="w-full"
              :readonly="!!selectedFile"
            />
          </UFormField>
          <UFormField
            :label="t('common.description')"
            name="skill-description"
            :description="t('skill.descriptionHelp')"
          >
            <UTextarea
              v-model="draft.description"
              :aria-label="t('skill.descriptionLabel')"
              :placeholder="t('skill.descriptionPlaceholder')"
              :rows="2"
              class="w-full"
              :readonly="!!selectedFile"
            />
          </UFormField>
          <UFormField
            :label="t('common.instructions')"
            name="skill-instructions"
            :description="t('skill.instructionsHelp')"
          >
            <UTextarea
              v-model="draft.content"
              :aria-label="t('skill.instructionsLabel')"
              :placeholder="t('skill.instructionsPlaceholder')"
              :rows="8"
              class="w-full font-mono"
              :readonly="!!selectedFile"
            />
          </UFormField>
          <USwitch v-if="!selectedFile" v-model="draft.enabled" :label="t('skill.enabled')" />
        </form>
        <div
          v-if="deleting"
          class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error/30 p-3"
        >
          <p class="text-sm">
            {{ t('skill.deleteDescription', { name: originalName ?? '' }) }}
          </p>
          <div class="flex gap-2">
            <UButton
              :label="t('skill.keep')"
              color="neutral"
              variant="ghost"
              @click="deleting = false"
            />
            <UButton :label="t('skill.confirmDelete')" color="error" @click="remove" />
          </div>
        </div>
      </template>

      <template v-else>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-sm font-semibold">
            {{ t(localSkills ? 'skill.savedApp' : 'skill.savedBrowser') }}
          </h3>
          <div class="flex gap-2">
            <input
              ref="importInput"
              type="file"
              accept=".md,.zip,text/markdown,application/zip,application/x-zip-compressed"
              :aria-label="t('skill.importFile')"
              class="hidden"
              @change="importFile"
            >
            <UButton
              :label="t('skill.import')"
              icon="i-lucide-upload"
              color="neutral"
              variant="outline"
              @click="importInput?.click()"
            />
            <UButton :label="t('skill.new')" icon="i-lucide-plus" @click="edit()" />
          </div>
        </div>
        <div
          v-if="!settings.skills.length"
          class="rounded-lg border border-dashed border-default px-4 py-8 text-center"
        >
          <UIcon name="i-lucide-book-open" class="size-7 text-dimmed" />
          <p class="mt-2 text-sm font-medium">
            {{ t('skill.empty') }}
          </p>
          <p class="mt-1 text-sm text-muted">
            {{ t('skill.emptyHelp') }}
          </p>
        </div>
        <ul v-else class="divide-y divide-default rounded-lg border border-default">
          <li v-for="skill in settings.skills" :key="skill.name" class="flex items-center gap-3 p-3">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">
                {{ skill.name }}
              </p>
              <p class="truncate text-sm text-muted">
                {{ skill.description }}
              </p>
            </div>
            <USwitch
              :model-value="skill.enabled"
              :aria-label="t('skill.enable', { name: skill.name })"
              @update:model-value="
                persist({
                  ...settings,
                  skills: settings.skills.map((item) =>
                    item.name === skill.name ? { ...item, enabled: $event } : item
                  )
                })
              "
            />
            <UButton
              :label="t('common.edit')"
              color="neutral"
              variant="ghost"
              :aria-label="t('skill.editName', { name: skill.name })"
              @click="edit(skill)"
            />
          </li>
        </ul>
        <p class="text-xs text-muted">
          {{ t('skill.importHelp') }}
        </p>
        <p class="text-xs text-muted">
          {{ t('skill.persistence') }}
        </p>

        <div v-if="localSkills" class="space-y-3 border-t border-default pt-5">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <USwitch
              :model-value="settings.loadLocal"
              :label="t('skill.loadLocal')"
              @update:model-value="persist({ ...settings, loadLocal: $event })"
            />
            <UButton
              :label="t('skill.refresh')"
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              :loading="loading"
              @click="refreshFiles"
            />
          </div>
          <p class="text-xs text-muted">
            {{ t('skill.localHelp') }}
          </p>
          <p v-for="root in roots" :key="root" class="text-xs text-muted break-all">
            {{ root }}
          </p>
          <UAlert
            v-if="fileError"
            color="error"
            :title="t('skill.localFailed')"
            :description="fileError"
          />
          <p v-else-if="!loading && !files.length" class="text-sm text-muted">
            {{ t('skill.localEmpty') }}
          </p>
          <ul v-else class="divide-y divide-default rounded-lg border border-default">
            <li v-for="file in files" :key="file.path" class="flex items-center gap-3 p-3">
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm font-medium">
                  {{ file.definition?.name ?? t('skill.invalidFile') }}
                </p>
                <p class="truncate text-xs text-muted" :title="file.path">
                  {{ file.path }}
                </p>
                <p v-if="file.error" class="text-xs text-error">
                  {{ file.error }}
                </p>
                <p
                  v-else-if="settings.skills.some((skill) => skill.enabled && skill.name === file.definition?.name)"
                  class="text-xs text-muted"
                >
                  {{ t('skill.priority') }}
                </p>
              </div>
              <USwitch
                :model-value="!settings.disabledFiles.includes(file.path)"
                :disabled="!settings.loadLocal"
                :aria-label="t('skill.enableFile', { path: file.path })"
                @update:model-value="toggleFile(file.path, $event)"
              />
              <UButton
                :label="t('common.view')"
                color="neutral"
                variant="ghost"
                :disabled="!file.definition"
                :aria-label="t('skill.viewName', { name: file.definition?.name ?? file.path })"
                @click="edit(undefined, file)"
              />
            </li>
          </ul>
        </div>
      </template>
      <p v-if="error" role="alert" class="text-sm text-error">
        {{ error }}
      </p>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-3 w-full">
      <UButton
        v-if="editing && originalName && !selectedFile"
        :label="t('skill.delete')"
        icon="i-lucide-trash-2"
        color="error"
        variant="ghost"
        @click="deleting = true"
      />
      <span v-else class="text-xs text-muted">{{
        editing && selectedFile
          ? t('skill.editInEditor')
          : t('skill.available')
      }}</span>
      <div class="flex gap-2">
        <UButton
          v-if="editing"
          :label="selectedFile ? t('common.done') : t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="backToSkills"
        />
        <UButton
          v-if="editing && !selectedFile"
          :label="t('skill.save')"
          type="submit"
          form="skill-editor"
        />
      </div>
    </div>
  </section>
</template>
