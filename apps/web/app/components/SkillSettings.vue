<script setup lang="ts">
import { parseSkillMarkdown } from '@keundal/plugin-skill-filesystem/markdown'

import { managedSkillSchema, type LocalSkillFile, type ManagedSkill, type SkillSettings } from '#shared/utils/skills'

defineProps<{ collapsed?: boolean }>()

const { $skillManager } = useNuxtApp()
const desktop = useRuntimeConfig().public.desktop
const open = ref(false)
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

watch(open, async (value) => {
  if (!value) return
  error.value = ''
  editing.value = false
  try {
    settings.value = $skillManager.load()
  } catch {
    error.value = 'Could not read saved skills. Check browser storage.'
  }
  if (desktop) await refreshFiles()
})

function persist(next: SkillSettings) {
  try {
    settings.value = $skillManager.save(next)
    error.value = ''
    return true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not save skills in this browser.'
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
    error.value = parsed.error.issues[0]!.message
    return
  }
  if (settings.value.skills.some((skill) => skill.name === parsed.data.name && skill.name !== originalName.value)) {
    error.value = `A skill named "${parsed.data.name}" already exists.`
    return
  }
  const skills = settings.value.skills.filter((skill) => skill.name !== originalName.value)
  if (persist({ ...settings.value, skills: [...skills, parsed.data].sort((a, b) => a.name.localeCompare(b.name)) }))
    editing.value = false
}

function remove() {
  if (
    persist({ ...settings.value, skills: settings.value.skills.filter((skill) => skill.name !== originalName.value) })
  )
    editing.value = false
}

async function importFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  try {
    const definition = parseSkillMarkdown(await file.text())
    edit()
    draft.value = { ...definition, enabled: true }
  } catch (cause) {
    error.value = `${file.name}: ${cause instanceof Error ? cause.message : String(cause)}`
  } finally {
    input.value = ''
  }
}

function toggleFile(path: string, enabled: boolean) {
  const disabledFiles = settings.value.disabledFiles.filter((file) => file !== path)
  if (!enabled) disabledFiles.push(path)
  persist({ ...settings.value, disabledFiles })
}
</script>

<template>
  <UModal
    v-model:open="open"
    title="Skills"
    description="Manage reusable instructions. The assistant loads enabled skills when needed."
    :ui="{ content: 'sm:max-w-3xl' }"
  >
    <UButton
      :label="collapsed ? '' : 'Skills'"
      icon="i-lucide-book-open"
      color="neutral"
      variant="ghost"
      class="w-full"
      aria-label="Skills"
    />

    <template #body>
      <div class="space-y-5">
        <UAlert
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="Instructions, not automatic actions"
          description="Skills can change assistant behavior. Only add instructions you trust. Scripts and supporting files do not run automatically."
        />

        <template v-if="editing">
          <div class="flex items-center justify-between gap-3">
            <UButton
              label="Back to skills"
              icon="i-lucide-arrow-left"
              variant="ghost"
              color="neutral"
              @click="backToSkills"
            />
            <UBadge v-if="selectedFile" label="Local file · read only" variant="subtle" color="neutral" />
            <span v-else class="text-sm text-muted">{{ originalName ? 'Edit skill' : 'New skill' }}</span>
          </div>
          <p v-if="selectedFile" class="text-xs text-muted break-all">
            {{ selectedFile.path }}
          </p>
          <form id="skill-editor" class="space-y-4" @submit.prevent="save">
            <UFormField label="Name" name="skill-name" description="Lowercase letters, numbers and single hyphens.">
              <UInput
                id="skill-name"
                v-model="draft.name"
                aria-label="Skill name"
                placeholder="code-review"
                class="w-full"
                :readonly="!!selectedFile"
              />
            </UFormField>
            <UFormField
              label="Description"
              name="skill-description"
              description="Tell the assistant when to use this skill."
            >
              <UTextarea
                v-model="draft.description"
                aria-label="Skill description"
                placeholder="Review code changes for bugs and regression risks."
                :rows="2"
                class="w-full"
                :readonly="!!selectedFile"
              />
            </UFormField>
            <UFormField
              label="Instructions"
              name="skill-instructions"
              description="Markdown is supported. Supporting files are not loaded automatically."
            >
              <UTextarea
                v-model="draft.content"
                aria-label="Skill instructions"
                placeholder="Describe the steps the assistant must follow…"
                :rows="8"
                class="w-full font-mono"
                :readonly="!!selectedFile"
              />
            </UFormField>
            <USwitch v-if="!selectedFile" v-model="draft.enabled" label="Enabled for new responses" />
          </form>
          <div
            v-if="deleting"
            class="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-error/30 p-3"
          >
            <p class="text-sm">Delete {{ originalName }}? This cannot be undone.</p>
            <div class="flex gap-2">
              <UButton label="Keep skill" color="neutral" variant="ghost" @click="deleting = false" />
              <UButton label="Confirm delete" color="error" @click="remove" />
            </div>
          </div>
        </template>

        <template v-else>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <h3 class="text-sm font-semibold">Saved in this {{ desktop ? 'app' : 'browser' }}</h3>
            <div class="flex gap-2">
              <input
                ref="importInput"
                type="file"
                accept=".md,text/markdown"
                aria-label="Import skill file"
                class="hidden"
                @change="importFile"
              />
              <UButton
                label="Import SKILL.md"
                icon="i-lucide-upload"
                color="neutral"
                variant="outline"
                @click="importInput?.click()"
              />
              <UButton label="New skill" icon="i-lucide-plus" @click="edit()" />
            </div>
          </div>
          <div
            v-if="!settings.skills.length"
            class="rounded-lg border border-dashed border-default px-4 py-8 text-center"
          >
            <UIcon name="i-lucide-book-open" class="size-7 text-dimmed" />
            <p class="mt-2 text-sm font-medium">No saved skills yet</p>
            <p class="mt-1 text-sm text-muted">Create a skill or import a SKILL.md file to get started.</p>
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
                :aria-label="`Enable ${skill.name}`"
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
                label="Edit"
                color="neutral"
                variant="ghost"
                :aria-label="`Edit ${skill.name}`"
                @click="edit(skill)"
              />
            </li>
          </ul>
          <p class="text-xs text-muted">
            Changes apply to the next response. Saved skills stay on this device and are not synced.
          </p>

          <div v-if="desktop" class="space-y-3 border-t border-default pt-5">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <USwitch
                :model-value="settings.loadLocal"
                label="Load .agents/skills"
                @update:model-value="persist({ ...settings, loadLocal: $event })"
              />
              <UButton
                label="Refresh files"
                icon="i-lucide-refresh-cw"
                color="neutral"
                variant="ghost"
                :loading="loading"
                @click="refreshFiles"
              />
            </div>
            <p class="text-xs text-muted">
              The app reads its launch directory and your home directory. Saved skills take priority, then
              launch-directory files.
            </p>
            <p v-for="root in roots" :key="root" class="text-xs text-muted break-all">
              {{ root }}
            </p>
            <UAlert v-if="fileError" color="error" title="Could not load local skills" :description="fileError" />
            <p v-else-if="!loading && !files.length" class="text-sm text-muted">
              No local SKILL.md files found. Add &lt;name&gt;/SKILL.md inside .agents/skills, then refresh.
            </p>
            <ul v-else class="divide-y divide-default rounded-lg border border-default">
              <li v-for="file in files" :key="file.path" class="flex items-center gap-3 p-3">
                <div class="min-w-0 flex-1">
                  <p class="truncate text-sm font-medium">
                    {{ file.definition?.name ?? 'Invalid skill file' }}
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
                    A saved skill with this name takes priority.
                  </p>
                </div>
                <USwitch
                  :model-value="!settings.disabledFiles.includes(file.path)"
                  :disabled="!settings.loadLocal"
                  :aria-label="`Enable file ${file.path}`"
                  @update:model-value="toggleFile(file.path, $event)"
                />
                <UButton
                  label="View"
                  color="neutral"
                  variant="ghost"
                  :disabled="!file.definition"
                  :aria-label="`View ${file.definition?.name ?? file.path}`"
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
    </template>

    <template #footer>
      <div class="flex items-center justify-between gap-3 w-full">
        <UButton
          v-if="editing && originalName && !selectedFile"
          label="Delete skill"
          icon="i-lucide-trash-2"
          color="error"
          variant="ghost"
          @click="deleting = true"
        />
        <span v-else class="text-xs text-muted">{{
          editing && selectedFile
            ? 'Edit this file in your text editor.'
            : 'Enabled skills are available in every chat.'
        }}</span>
        <div class="flex gap-2">
          <UButton
            :label="editing && !selectedFile ? 'Cancel' : 'Done'"
            color="neutral"
            variant="ghost"
            @click="editing ? (editing = false) : (open = false)"
          />
          <UButton v-if="editing && !selectedFile" label="Save skill" type="submit" form="skill-editor" />
        </div>
      </div>
    </template>
  </UModal>
</template>
