<script setup lang="ts">
import type { ExecutionOptions } from '@keundal/core'
import type { GenerationSnapshot } from '@keundal/generation'
import type { ChatIndicatorOwner } from '@keundal/ui/app/contracts/chat.ts'
import { reactive } from 'vue'
import { restoreExecution, type LiveExecution } from '../lib/live-execution'
import { useText } from '../locale'

const props = defineProps<{
  messages: ChatIndicatorOwner['messages']
  status: ChatIndicatorOwner['status']
  live: LiveExecution
  getRun: (runId: string, options?: ExecutionOptions) => Promise<GenerationSnapshot | undefined>
}>()

const { t, intlLocale } = useText()
const runs = props.live.runs
const selected = ref('')
const failed = reactive(new Set<string>())
const loaded = new Set<string>()
const requests = new Map<string, AbortController>()
const refreshAfterLoad = new Set<string>()
let disposed = false
const loading = ref(0)
const runIds = computed(() => [...new Set([
  ...props.messages.filter(message => message.role === 'assistant').map(message => message.id),
  ...(props.live.activeRunId ? [props.live.activeRunId] : [])
])])
const acpRuns = computed(() => runIds.value.filter(id => runs.get(id)?.sessionId))
const currentId = computed(() => acpRuns.value.includes(selected.value) ? selected.value : acpRuns.value.at(-1))
const current = computed(() => currentId.value ? runs.get(currentId.value) : undefined)
const tools = computed(() => [...(current.value?.tools.values() ?? [])])
const files = computed(() => tools.value.flatMap(tool => (tool.content ?? []).flatMap((content, index) =>
  content.type === 'diff' ? [{ ...content, key: `${tool.toolCallId}:${index}`, tool }] : [])))

async function load(id: string, refresh = false) {
  if (disposed) return
  if (requests.has(id)) {
    if (refresh) refreshAfterLoad.add(id)
    return
  }
  const controller = new AbortController()
  requests.set(id, controller)
  loading.value++
  failed.delete(id)
  try {
    const snapshot = await props.getRun(id, { signal: controller.signal })
    if (controller.signal.aborted) return
    if (snapshot) restoreExecution(props.live, id, snapshot)
    loaded.add(id)
  } catch {
    if (!controller.signal.aborted) failed.add(id)
  } finally {
    requests.delete(id)
    loading.value--
    if (refreshAfterLoad.delete(id)) void load(id)
  }
}

watch(() => runIds.value.join('\n'), async () => {
  for (const id of runIds.value) if (!loaded.has(id) && !failed.has(id)) await load(id)
}, { immediate: true })
watch(() => props.status, (status) => {
  if (status !== 'streaming' && status !== 'submitted' && props.live.activeRunId) void load(props.live.activeRunId, true)
})

onBeforeUnmount(() => {
  disposed = true
  for (const controller of requests.values()) controller.abort()
})

function stepStatus(status?: string | null) {
  status ??= 'pending'
  if (current.value?.status !== 'running' && (status === 'pending' || status === 'in_progress')) return t('acp.unfinished')
  return t(`acp.${status as 'pending' | 'in_progress' | 'completed' | 'failed'}`)
}
function tone(status?: string | null) {
  if (status === 'failed') return 'text-error'
  if (status === 'completed') return 'text-success'
  return 'text-muted'
}
function raw(value: unknown) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}
function number(value: number) { return new Intl.NumberFormat(intlLocale.value, { maximumFractionDigits: 8 }).format(value) }
</script>

<template>
  <section v-if="current || failed.size" class="my-4 min-w-0 rounded-xl border border-default bg-default" :aria-label="t('acp.title')" :aria-busy="loading > 0">
    <details open>
      <summary class="cursor-pointer rounded-xl px-4 py-3 text-sm font-semibold select-none hover:bg-elevated">
        {{ t('acp.title') }}
        <span v-if="current" class="ml-2 text-xs font-normal" :class="tone(current.status)">{{ t(`acp.${current.status}`) }}</span>
      </summary>
      <div class="space-y-4 border-t border-default p-4">
        <div v-if="failed.size" role="alert" class="flex flex-wrap items-center gap-2 text-sm text-error">
          {{ t('acp.error') }}
          <UButton size="xs" color="neutral" variant="outline" :label="t('acp.retry')" @click="[...failed].forEach(id => load(id))" />
        </div>
        <p v-if="loading && !current" role="status" class="text-sm text-muted">{{ t('acp.loading') }}</p>
        <template v-if="current">
          <div class="flex flex-wrap items-center gap-2">
            <label class="text-xs text-muted">
              {{ t('acp.run') }}
              <select :value="currentId" class="ml-2 max-w-full rounded-md border border-default bg-default p-1.5 text-sm text-default" @change="selected = ($event.target as HTMLSelectElement).value">
                <option v-for="(id, index) in acpRuns" :key="id" :value="id">{{ index + 1 }} · {{ id.slice(0, 8) }}</option>
              </select>
            </label>
            <span class="min-w-0 break-all text-xs text-muted">{{ t('acp.session') }} · {{ current.sessionId }}</span>
          </div>
          <dl v-if="current.usage" class="flex flex-wrap gap-x-8 gap-y-2 rounded-lg bg-elevated p-3 text-xs">
            <div>
              <dt class="text-muted">{{ t('acp.context') }}</dt>
              <dd class="mt-1 font-mono">{{ number(current.usage.used) }} / {{ number(current.usage.size) }}</dd>
            </div>
            <div v-if="current.usage.cost">
              <dt class="text-muted">{{ t('acp.cost') }}</dt>
              <dd class="mt-1 font-mono">{{ number(current.usage.cost.amount) }} {{ current.usage.cost.currency }}</dd>
            </div>
          </dl>
          <div v-if="current.plan.length || tools.length" class="grid min-w-0 gap-5 md:grid-cols-2">
            <section v-if="current.plan.length" :aria-label="t('acp.plan')" class="min-w-0">
              <h3 class="mb-3 text-sm font-semibold">{{ t('acp.plan') }} <span class="text-muted">{{ current.plan.filter(entry => entry.status === 'completed').length }}/{{ current.plan.length }}</span></h3>
              <ol class="space-y-3 text-sm">
                <li v-for="(entry, index) in current.plan" :key="index" class="flex gap-2">
                  <span class="pt-0.5 text-xs text-muted">{{ index + 1 }}.</span>
                  <div class="min-w-0"><p class="whitespace-pre-wrap break-words">{{ entry.content }}</p><p class="mt-0.5 text-xs" :class="tone(entry.status)">{{ stepStatus(entry.status) }}</p></div>
                </li>
              </ol>
            </section>
            <section v-if="tools.length" :aria-label="t('acp.tools')" class="min-w-0">
              <h3 class="mb-3 text-sm font-semibold">{{ t('acp.tools') }} <span class="text-muted">{{ tools.length }}</span></h3>
              <ol class="space-y-2 text-sm">
                <li v-for="tool in tools" :key="tool.toolCallId" class="min-w-0 rounded-lg border border-default">
                  <details>
                    <summary class="cursor-pointer break-words rounded-lg p-2 hover:bg-elevated">
                      {{ tool.title ?? tool.name ?? tool.toolCallId }}
                      <span class="ml-1 text-xs" :class="tone(tool.status)">{{ stepStatus(tool.status) }}</span>
                    </summary>
                    <div class="space-y-2 border-t border-default p-2 text-xs">
                      <p class="break-all text-muted">ACP · {{ tool.toolCallId }}<template v-if="tool.aguiToolCallId"> · AG-UI · {{ tool.aguiToolCallId }}</template></p>
                      <p v-for="(location, index) in tool.locations ?? []" :key="index" class="break-all font-mono">{{ location.path }}<template v-if="location.line != null">:{{ location.line }}</template></p>
                      <template v-if="tool.rawInput !== undefined"><h4 class="font-medium">{{ t('acp.input') }}</h4><pre class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-elevated p-2">{{ raw(tool.rawInput) }}</pre></template>
                      <template v-if="tool.rawOutput !== undefined"><h4 class="font-medium">{{ t('acp.output') }}</h4><pre class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-elevated p-2">{{ raw(tool.rawOutput) }}</pre></template>
                      <template v-for="(content, index) in tool.content ?? []" :key="index"><pre v-if="content.type === 'content' && content.content.type === 'text'" class="max-h-60 overflow-auto whitespace-pre-wrap break-all">{{ content.content.text }}</pre></template>
                    </div>
                  </details>
                </li>
              </ol>
            </section>
          </div>
          <p v-else class="text-sm text-muted">{{ t('acp.empty') }}</p>
          <section :aria-label="t('acp.files')">
            <h3 class="mb-3 text-sm font-semibold">{{ t('acp.files') }} <span class="text-muted">{{ files.length }}</span></h3>
            <p v-if="!files.length" class="text-xs text-muted">{{ t('acp.noChanges') }}</p>
            <div v-else class="space-y-2">
              <details v-for="file in files" :key="`${currentId}:${file.key}`" class="min-w-0 rounded-lg border border-default">
                <summary class="cursor-pointer break-all rounded-lg p-3 text-xs hover:bg-elevated">
                  <span class="font-mono">{{ file.path }}</span>
                  <span class="ml-2" :class="tone(file.tool.status)">{{ stepStatus(file.tool.status) }}</span>
                </summary>
                <div class="grid min-w-0 border-t border-default md:grid-cols-2">
                  <div class="min-w-0 bg-error/5 p-3"><h4 class="mb-2 text-xs font-medium text-error">{{ t('acp.before') }}<template v-if="file.oldText == null"> · {{ t('acp.newFile') }}</template></h4><pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"><code>{{ file.oldText ?? '' }}</code></pre></div>
                  <div class="min-w-0 bg-success/5 p-3"><h4 class="mb-2 text-xs font-medium text-success">{{ t('acp.after') }}</h4><pre class="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs"><code>{{ file.newText }}</code></pre></div>
                </div>
              </details>
            </div>
          </section>
        </template>
      </div>
    </details>
  </section>
</template>
