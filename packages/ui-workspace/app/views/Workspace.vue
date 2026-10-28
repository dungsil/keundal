<script setup lang="ts">
import type { CodingWorkspaceSnapshot } from '@keundal/workspace'
import type { Ref } from 'vue'
import { useText } from '../locale'

const props = defineProps<{
  threadId?: string
  disabled: boolean
  running: boolean
  available: Ref<boolean>
  getWorkspace(id: string): Promise<CodingWorkspaceSnapshot | undefined>
  createWorkspace(id: string, path: string): Promise<CodingWorkspaceSnapshot>
  reviewWorkspace(id: string): Promise<CodingWorkspaceSnapshot>
  applyWorkspace(id: string, reviewId: string): Promise<CodingWorkspaceSnapshot>
}>()
const { t } = useText()
const open = ref(false)
const project = ref('')
const workspace = ref<CodingWorkspaceSnapshot>()
const loading = ref(false)
const error = ref('')
const applied = ref(false)
const projectId = useId()

async function perform(action: () => Promise<CodingWorkspaceSnapshot | undefined>) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  applied.value = false
  try {
    workspace.value = await action()
  } catch (cause) {
    if (workspace.value) workspace.value = { ...workspace.value, reviewId: undefined }
    error.value = cause instanceof Error ? cause.message : t('workspace.failed')
  } finally {
    loading.value = false
  }
}

watch([() => props.threadId, () => props.available.value], async ([id, available]) => {
  workspace.value = undefined
  if (!id || !available) return
  try { workspace.value = await props.getWorkspace(id) } catch { /* Opening the dialog offers a retry. */ }
}, { immediate: true })

watch(open, (value) => {
  if (value && props.threadId && props.available.value) void perform(() => props.getWorkspace(props.threadId!))
})
watch(() => props.running, () => {
  if (workspace.value) workspace.value = { ...workspace.value, reviewId: undefined }
})

async function apply() {
  const reviewId = workspace.value?.reviewId
  if (!reviewId || !props.threadId || props.running) return
  await perform(() => props.applyWorkspace(props.threadId!, reviewId))
  applied.value = !error.value
}
</script>

<template>
  <UModal v-model:open="open" :title="t('workspace.title')" :ui="{ content: 'sm:max-w-3xl' }">
    <UButton
      :label="t(workspace ? 'workspace.coding' : 'workspace.title')"
      icon="i-lucide-git-branch"
      color="neutral"
      :variant="workspace ? 'soft' : 'ghost'"
      size="sm"
      :disabled="disabled || !threadId"
    />
    <template #body>
      <div class="min-w-0 space-y-4">
        <p v-if="!available.value" role="status" class="text-sm text-muted">{{ t('workspace.unavailable') }}</p>
        <template v-else>
          <p v-if="error" role="alert" class="break-words text-sm text-error">{{ error }}</p>
          <p v-if="applied" role="status" class="text-sm text-success">{{ t('workspace.applied') }}</p>
          <p v-if="running" role="status" class="text-sm text-warning">{{ t('workspace.running') }}</p>
          <form v-if="!workspace" class="space-y-4" @submit.prevent="perform(() => createWorkspace(threadId!, project))">
            <p class="text-sm text-muted">{{ t('workspace.warning') }}</p>
            <div class="space-y-2">
              <label :for="projectId" class="block text-sm font-medium">{{ t('workspace.project') }}</label>
              <UInput :id="projectId" v-model="project" class="w-full" placeholder="/projects/my-app" :disabled="loading || running" required />
            </div>
            <UButton type="submit" :label="t('workspace.create')" :loading="loading" :disabled="!project.trim() || running" />
          </form>
          <template v-else>
            <dl class="space-y-2 text-sm">
              <div><dt class="text-muted">{{ t('workspace.project') }}</dt><dd class="break-all font-mono">{{ workspace.projectPath }}</dd></div>
              <div><dt class="text-muted">{{ t('workspace.path') }}</dt><dd class="break-all font-mono">{{ workspace.path }}</dd></div>
            </dl>
            <div class="flex flex-wrap gap-2">
              <UButton :label="t('workspace.review')" icon="i-lucide-refresh-cw" color="neutral" variant="outline" :loading="loading" :disabled="running" @click="perform(() => reviewWorkspace(threadId!))" />
              <UButton :label="t('workspace.apply')" icon="i-lucide-check" :loading="loading" :disabled="running || !workspace.reviewId || !workspace.patch" @click="apply" />
            </div>
            <template v-if="workspace.reviewId">
              <p v-if="!workspace.patch" role="status" class="text-sm text-muted">{{ t('workspace.empty') }}</p>
              <template v-else>
                <ul class="max-h-32 overflow-auto text-sm font-mono" :aria-label="t('workspace.review')">
                  <li v-for="change in workspace.changes" :key="change.path" class="break-all">{{ change.index }}{{ change.workingTree }} {{ change.path }}</li>
                </ul>
                <pre tabindex="0" :aria-label="t('workspace.review')" class="max-h-[45vh] overflow-auto rounded-md border border-default bg-muted p-3 text-xs"><code>{{ workspace.patch }}</code></pre>
              </template>
            </template>
          </template>
        </template>
      </div>
    </template>
  </UModal>
</template>
