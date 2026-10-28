<script setup lang="ts">
import type { TaskSnapshot } from '@keundal/task'
import { useText } from '../locale'

const props = defineProps<{
  listTasks: () => Promise<TaskSnapshot[]>
  cancelTask: (id: string) => Promise<boolean>
}>()
const { t } = useText()
const tasks = ref<TaskSnapshot[]>([])
const loading = ref(true)
const error = ref('')
const cancelling = ref<string[]>([])
let timer: ReturnType<typeof setTimeout> | undefined
let stopped = false
let refreshing = false

async function refresh() {
  if (refreshing || stopped) return
  clearTimeout(timer)
  refreshing = true
  try {
    const result = await props.listTasks()
    if (stopped) return
    tasks.value = result
    error.value = ''
  } catch {
    if (!stopped) error.value = t('tasks.loadFailed')
  } finally {
    refreshing = false
    loading.value = false
    if (!stopped) timer = setTimeout(refresh, 2000)
  }
}

async function cancel(id: string) {
  cancelling.value.push(id)
  try {
    await props.cancelTask(id)
    await refresh()
  } catch {
    error.value = t('tasks.cancelFailed')
  } finally {
    cancelling.value = cancelling.value.filter(value => value !== id)
  }
}

onMounted(refresh)
onBeforeUnmount(() => {
  stopped = true
  clearTimeout(timer)
})
</script>

<template>
  <section class="min-w-0 space-y-4" aria-labelledby="background-tasks-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="background-tasks-title" class="text-lg font-semibold text-highlighted">{{ t('tasks.title') }}</h2>
      <UButton :label="t('tasks.refresh')" icon="i-lucide-refresh-cw" color="neutral" variant="outline" :loading="loading" @click="refresh" />
    </div>
    <p class="text-sm text-muted">{{ t('tasks.memoryOnly') }}</p>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <p v-if="loading" role="status" class="text-sm text-muted">{{ t('tasks.loading') }}</p>
    <p v-else-if="!tasks.length && !error" class="rounded-lg border border-default p-4 text-sm text-muted">{{ t('tasks.empty') }}</p>
    <article v-for="task in tasks" :key="task.id" class="min-w-0 space-y-3 rounded-lg border border-default p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h3 class="min-w-0 break-words font-medium text-highlighted">{{ task.label || task.id }}</h3>
        <UBadge :color="task.status === 'failed' ? 'error' : task.status === 'completed' ? 'success' : 'neutral'" variant="subtle" role="status">{{ t(`tasks.${task.status}`) }}</UBadge>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-2">
        <UButton :to="`/chat/${encodeURIComponent(task.parentThreadId)}`" :label="t('tasks.parent')" icon="i-lucide-arrow-up-right" color="neutral" variant="link" />
        <UButton v-if="task.status === 'queued' || task.status === 'running'" :label="t('tasks.cancel')" color="error" variant="outline" :loading="cancelling.includes(task.id)" @click="cancel(task.id)" />
      </div>
      <p v-if="task.content && task.status !== 'completed'" class="text-sm text-muted">{{ t('tasks.partial') }}</p>
      <div v-if="task.content" class="min-w-0 overflow-x-auto break-words text-sm">
        <ChatMarkdown :value="task.content" :streaming="task.status === 'running'" />
      </div>
      <p v-if="task.error" class="whitespace-pre-wrap break-words text-sm text-error">{{ task.error }}</p>
    </article>
  </section>
</template>
