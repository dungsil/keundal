<script setup lang="ts">
import type { MemoryDraft, MemoryEntry, MemoryScope } from '@keundal/memory'
import type { ChatSummary } from '@keundal/ui-runtime'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  listMemories: () => Promise<MemoryEntry[]>
  saveMemory: (draft: MemoryDraft, id?: string, expectedRevision?: number) => Promise<MemoryEntry>
  deleteMemory: (id: string, expectedRevision: number) => Promise<void>
  searchMemories: (text: string, projectId?: string, threadId?: string, semantic?: boolean) => Promise<MemoryEntry[]>
  memoryProject: Ref<string>
  saveMemoryProject: (id: string) => void
  chats: Ref<ChatSummary[] | undefined>
}>()

const { t } = useText()
const activeProject = ref(props.memoryProject.value)
const project = ref(props.memoryProject.value)
const conversation = ref('')
const filter = ref<'all' | MemoryScope['type']>('all')
const query = ref('')
const semantic = ref(false)
const memories = ref<MemoryEntry[]>([])
const results = ref<MemoryEntry[] | null>(null)
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const projectError = ref('')
const projectStatus = ref('')
const editorError = ref('')
const editing = ref(false)
const original = ref<MemoryEntry | null>(null)
const scopeType = ref<MemoryScope['type']>()
const draftProject = ref('')
const draftConversation = ref('')
const title = ref('')
const content = ref('')
const sourceLabel = ref('')
const sourceUri = ref('')
const sourceConversation = ref('')
const deleting = ref<string | null>(null)
let request = 0
let stopped = false

const chats = computed(() => props.chats.value ?? [])
const optionalConversations = computed(() => [
  { value: 'none', label: t('memory.noConversation') },
  ...chats.value.map(chat => ({ value: `chat:${chat.id}`, label: chat.title || t('memory.untitled') }))
])
const selectedConversation = computed({
  get: () => conversation.value ? `chat:${conversation.value}` : 'none',
  set: (value: string) => { conversation.value = value.startsWith('chat:') ? value.slice(5) : '' }
})
const selectedSourceConversation = computed({
  get: () => sourceConversation.value ? `chat:${sourceConversation.value}` : 'none',
  set: (value: string) => { sourceConversation.value = value.startsWith('chat:') ? value.slice(5) : '' }
})
const needsContext = computed(() => (filter.value === 'project' && !project.value.trim()) || (filter.value === 'conversation' && !conversation.value))
const visible = computed(() => (results.value ?? memories.value).filter(entry => {
  if (filter.value === 'all') return true
  if (entry.scope.type !== filter.value) return false
  if (entry.scope.type === 'project') return entry.scope.id === project.value.trim()
  if (entry.scope.type === 'conversation') return entry.scope.id === conversation.value
  return true
}))

watch(() => props.memoryProject.value, (value, previous) => {
  if (activeProject.value === previous) activeProject.value = value
  if (project.value === previous) project.value = value
})
watch([filter, project, conversation], () => {
  request++
  loading.value = false
  results.value = null
  error.value = ''
  deleting.value = null
})
onMounted(() => load(false))
onBeforeUnmount(() => { stopped = true; request++ })

async function focus(id: string) {
  await nextTick()
  if (!stopped) (document.getElementById(id) ?? document.getElementById('memory-title'))?.focus()
}

function saveProject() {
  projectError.value = ''
  projectStatus.value = ''
  const id = activeProject.value.trim()
  try {
    props.saveMemoryProject(id)
    activeProject.value = id
    project.value = id
    projectStatus.value = t('memory.saved')
  } catch {
    projectError.value = t('memory.saveFailed')
  }
}

async function load(search: boolean) {
  if (busy.value) return
  error.value = ''
  if (search && !query.value.trim()) { error.value = t('memory.invalidQuery'); await focus('memory-query'); return }
  if (search && needsContext.value) { error.value = t('memory.chooseContext'); return }
  const token = ++request
  loading.value = true
  try {
    const entries = search
      ? await props.searchMemories(query.value.trim(), project.value.trim() || undefined, conversation.value || undefined, semantic.value)
      : await props.listMemories()
    if (token !== request || stopped) return
    if (search) results.value = entries
    else { memories.value = entries; results.value = null }
  } catch {
    if (token === request && !stopped) error.value = t(search ? 'memory.searchFailed' : 'memory.loadFailed')
  } finally {
    if (token === request && !stopped) loading.value = false
  }
}

function scopeLabel(scope: MemoryScope) {
  return `${t(`memory.${scope.type}`)}${scope.type === 'user' ? '' : ` · ${scope.id}`}`
}

function sourceLink(uri: string) {
  try {
    const url = new URL(uri)
    if (url.protocol === 'keundal:' && url.hostname === 'threads') {
      const id = url.pathname.split('/')[1]
      if (id) return `/chat/${encodeURIComponent(decodeURIComponent(id))}`
    }
  } catch { /* Non-conversation references are displayed without opening them. */ }
  return undefined
}

function dateLabel(value: MemoryEntry['createdAt']) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
}

async function edit(entry?: MemoryEntry) {
  original.value = entry ?? null
  scopeType.value = entry?.scope.type
  draftProject.value = entry?.scope.type === 'project' ? entry.scope.id : project.value.trim()
  draftConversation.value = entry?.scope.type === 'conversation' ? entry.scope.id : conversation.value
  title.value = entry?.title ?? ''
  content.value = entry?.content ?? ''
  sourceLabel.value = ''
  sourceUri.value = ''
  sourceConversation.value = ''
  editorError.value = ''
  deleting.value = null
  editing.value = true
  await focus(entry ? 'memory-content' : 'memory-draft-scope')
}

async function closeEditor() {
  const id = original.value?.id
  editing.value = false
  editorError.value = ''
  await focus(id ? `memory-edit-${id}` : 'memory-add')
}

async function save() {
  if (busy.value) return
  editorError.value = ''
  const fail = async (key: Parameters<typeof t>[0], id: string) => { editorError.value = t(key); await focus(id) }
  if (!scopeType.value) return fail('memory.invalidScope', 'memory-draft-scope')
  const scopeId = scopeType.value === 'project' ? draftProject.value.trim() : draftConversation.value
  if (scopeType.value !== 'user' && !scopeId) return fail('memory.invalidId', scopeType.value === 'project' ? 'memory-draft-project' : 'memory-draft-conversation')
  if (!title.value.trim()) return fail('memory.invalidTitle', 'memory-entry-title')
  if (!content.value.trim()) return fail('memory.invalidContent', 'memory-content')
  if (!original.value && !sourceUri.value.trim() && !sourceConversation.value) return fail('memory.invalidSource', 'memory-source-uri')
  const scope: MemoryScope = scopeType.value === 'user' ? { type: 'user' } : { type: scopeType.value, id: scopeId }
  const draft: MemoryDraft = {
    scope: original.value?.scope ?? scope,
    title: title.value.trim(),
    content: content.value.trim(),
    sources: original.value ? original.value.sources.map(source => ({ ...source })) : [
      ...(sourceUri.value.trim() ? [{ uri: sourceUri.value.trim(), ...(sourceLabel.value.trim() ? { label: sourceLabel.value.trim() } : {}) }] : []),
      ...(sourceConversation.value ? [{ uri: `keundal://threads/${encodeURIComponent(sourceConversation.value)}`, label: chats.value.find(chat => chat.id === sourceConversation.value)?.title || t('memory.conversation') }] : [])
    ]
  }
  busy.value = true
  try {
    const saved = await props.saveMemory(draft, original.value?.id, original.value?.revision)
    if (stopped) return
    memories.value = [saved, ...memories.value.filter(entry => entry.id !== saved.id)]
    results.value = null
    busy.value = false
    await closeEditor()
  } catch {
    if (!stopped) editorError.value = t('memory.saveFailed')
  } finally { busy.value = false }
}

async function requestDelete(id: string) {
  deleting.value = id
  error.value = ''
  await focus(`memory-confirm-${id}`)
}

async function cancelDelete(id: string) {
  deleting.value = null
  await focus(`memory-delete-${id}`)
}

async function remove(entry: MemoryEntry) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await props.deleteMemory(entry.id, entry.revision)
    if (stopped) return
    memories.value = memories.value.filter(memory => memory.id !== entry.id)
    if (results.value) results.value = results.value.filter(memory => memory.id !== entry.id)
    deleting.value = null
    await focus('memory-title')
  } catch {
    if (!stopped) error.value = t('memory.deleteFailed')
  } finally { busy.value = false }
}
</script>

<template>
  <section class="min-w-0 space-y-5" aria-labelledby="memory-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="memory-title" tabindex="-1" class="text-lg font-semibold text-highlighted">{{ t('memory.title') }}</h2>
      <UButton v-if="!editing" id="memory-add" :label="t('memory.add')" icon="i-lucide-plus" :disabled="busy || loading" @click="edit()" />
    </div>

    <form class="space-y-3 rounded-lg border border-default p-4" @submit.prevent="saveProject">
      <UFormField :label="t('memory.activeProject')" name="memory-active-project" :error="projectError || undefined">
        <UInput id="memory-active-project" v-model="activeProject" class="w-full" :disabled="busy || loading" @update:model-value="projectStatus = ''" />
      </UFormField>
      <div class="flex items-center justify-end gap-3">
        <p role="status" class="text-sm text-muted">{{ projectStatus }}</p>
        <UButton type="submit" :label="t('memory.save')" :disabled="busy || loading" />
      </div>
    </form>

    <form v-if="editing" class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="save" @keydown.esc.prevent="!busy && closeEditor()">
      <h3 class="font-medium text-highlighted">{{ t(original ? 'memory.edit' : 'memory.add') }}</h3>
      <fieldset :disabled="busy" class="min-w-0 space-y-4">
        <template v-if="!original">
          <UFormField :label="t('memory.scope')" name="memory-draft-scope" required>
            <USelect id="memory-draft-scope" v-model="scopeType" :placeholder="t('memory.chooseScope')" :items="(['user', 'project', 'conversation'] as const).map(value => ({ value, label: t(`memory.${value}`) }))" class="w-full" />
          </UFormField>
          <UFormField v-if="scopeType === 'project'" :label="t('memory.projectId')" name="memory-draft-project" required>
            <UInput id="memory-draft-project" v-model="draftProject" class="w-full" />
          </UFormField>
          <UFormField v-if="scopeType === 'conversation'" :label="t('memory.conversation')" name="memory-draft-conversation" required>
            <USelect id="memory-draft-conversation" v-model="draftConversation" :placeholder="t('memory.chooseConversation')" :items="chats.map(chat => ({ value: chat.id, label: chat.title || t('memory.untitled') }))" class="w-full" />
          </UFormField>
        </template>
        <p v-else class="break-words text-sm text-muted">{{ scopeLabel(original.scope) }}</p>
        <UFormField :label="t('memory.entryTitle')" name="memory-entry-title" required>
          <UInput id="memory-entry-title" v-model="title" class="w-full" />
        </UFormField>
        <UFormField :label="t('memory.content')" name="memory-content" required>
          <UTextarea id="memory-content" v-model="content" :rows="5" class="w-full" />
        </UFormField>
        <template v-if="!original">
          <UFormField :label="t('memory.sourceUri')" name="memory-source-uri">
            <UInput id="memory-source-uri" v-model="sourceUri" class="w-full" />
          </UFormField>
          <UFormField :label="t('memory.source')" name="memory-source">
            <UInput id="memory-source" v-model="sourceLabel" class="w-full" />
          </UFormField>
          <UFormField :label="t('memory.sourceConversation')" name="memory-source-conversation">
            <USelect id="memory-source-conversation" v-model="selectedSourceConversation" :items="optionalConversations" class="w-full" />
          </UFormField>
        </template>
        <div v-else class="space-y-2 text-sm text-muted">
          <p>{{ t('memory.revision') }}: {{ original.revision }}</p>
          <p v-for="(source, index) in original.sources" :key="index" class="break-words">{{ source.label }} {{ source.uri }}</p>
        </div>
      </fieldset>
      <p v-if="editorError" role="alert" class="text-sm text-error">{{ editorError }}</p>
      <div class="flex justify-end gap-2">
        <UButton :label="t('memory.cancel')" color="neutral" variant="outline" :disabled="busy" @click="closeEditor" />
        <UButton type="submit" :label="t('memory.save')" :loading="busy" />
      </div>
    </form>

    <template v-else>
      <form class="space-y-4" @submit.prevent="load(true)">
        <fieldset :disabled="busy || loading" class="min-w-0 space-y-4">
          <UFormField :label="t('memory.scope')" name="memory-filter">
            <USelect v-model="filter" :items="(['all', 'user', 'project', 'conversation'] as const).map(value => ({ value, label: t(`memory.${value}`) }))" class="w-full" />
          </UFormField>
          <div class="grid min-w-0 gap-4 sm:grid-cols-2">
            <UFormField :label="t('memory.searchProject')" name="memory-project">
              <UInput v-model="project" class="w-full" />
            </UFormField>
            <UFormField :label="t('memory.searchConversation')" name="memory-conversation">
              <USelect v-model="selectedConversation" :items="optionalConversations" class="w-full" />
            </UFormField>
          </div>
          <UFormField :label="t('memory.query')" name="memory-query">
            <UInput id="memory-query" v-model="query" :maxlength="4000" class="w-full" />
          </UFormField>
          <UCheckbox v-model="semantic" :label="t('memory.semantic')" />
        </fieldset>
        <div class="flex flex-wrap gap-2">
          <UButton type="submit" :label="t('memory.search')" icon="i-lucide-search" :disabled="busy || loading" />
          <UButton :label="t('memory.refresh')" color="neutral" variant="outline" :disabled="busy || loading" @click="load(false)" />
        </div>
      </form>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <p v-if="loading" role="status" class="text-sm text-muted">{{ t('memory.loading') }}</p>
      <p v-else-if="needsContext" role="status" class="text-sm text-muted">{{ t('memory.chooseContext') }}</p>
      <template v-else>
        <p v-if="results !== null" role="status" class="text-sm text-muted">{{ t('memory.results') }} · {{ visible.length }}</p>
        <p v-if="!visible.length && !error" class="rounded-lg border border-default p-4 text-sm text-muted">{{ t('memory.empty') }}</p>
        <article v-for="entry in visible" :key="entry.id" class="min-w-0 space-y-3 rounded-lg border border-default p-4">
          <p class="break-words text-sm font-medium text-highlighted">{{ scopeLabel(entry.scope) }}</p>
          <h3 class="break-words font-medium text-highlighted">{{ entry.title }}</h3>
          <p class="whitespace-pre-wrap break-words text-sm">{{ entry.content }}</p>
          <div class="space-y-1 text-sm text-muted">
            <div v-for="(source, index) in entry.sources" :key="index" class="break-words">
              <p>{{ source.label }} {{ source.uri }}</p>
              <UButton v-if="sourceLink(source.uri)" :to="sourceLink(source.uri)" :label="t('memory.openSource')" icon="i-lucide-arrow-up-right" color="neutral" variant="link" />
            </div>
            <p>{{ t('memory.revision') }}: {{ entry.revision }}</p>
            <p>{{ t('memory.created') }}: {{ dateLabel(entry.createdAt) }}</p>
            <p>{{ t('memory.updated') }}: {{ dateLabel(entry.updatedAt) }}</p>
          </div>
          <div v-if="deleting === entry.id" class="space-y-3" @keydown.esc.prevent="!busy && cancelDelete(entry.id)">
            <p :id="`memory-delete-description-${entry.id}`" class="text-sm font-medium">{{ t('memory.confirmDelete') }}</p>
            <div class="flex flex-wrap gap-2">
              <UButton :id="`memory-confirm-${entry.id}`" :aria-describedby="`memory-delete-description-${entry.id}`" :label="t('memory.confirm')" color="error" :loading="busy" @click="remove(entry)" />
              <UButton :label="t('memory.cancel')" color="neutral" variant="outline" :disabled="busy" @click="cancelDelete(entry.id)" />
            </div>
          </div>
          <div v-else class="flex flex-wrap gap-2">
            <UButton :id="`memory-edit-${entry.id}`" :label="t('memory.edit')" icon="i-lucide-pencil" color="neutral" variant="outline" :disabled="busy" @click="edit(entry)" />
            <UButton :id="`memory-delete-${entry.id}`" :label="t('memory.delete')" icon="i-lucide-trash-2" color="error" variant="ghost" :disabled="busy" @click="requestDelete(entry.id)" />
          </div>
        </article>
      </template>
    </template>
  </section>
</template>
