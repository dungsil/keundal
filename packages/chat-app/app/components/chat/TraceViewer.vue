<script setup lang="ts">
import { readTraceSpans, summarizeTrace } from '@keundal/core'
import type { AGUIEvent, GenerationSnapshot, TraceSpan } from '@keundal/core'
import { shallowRef } from 'vue'
import { flattenTraceSpans, reconcileTraceSpans, traceDisplayStatus, traceTimelineBounds, traceUsageCompleteness, traceRunDuration } from '../../utils/trace'

const props = defineProps<{
  runId: string
  live: boolean
  liveSpans?: readonly TraceSpan[]
}>()

const { t, intlLocale } = useLocale()
const { $chatStore } = useNuxtApp()
const expanded = ref(false)
const mode = ref<'simple' | 'full'>('simple')
const snapshot = shallowRef<{ status: GenerationSnapshot['status']; eventCount: number }>()
const spanCache = shallowRef(new Map<string, TraceSpan>())
const legacyCounts = shallowRef(new Map<string, number>())
const loading = ref(false)
const failed = ref(false)
const truncated = ref(false)
let timer: ReturnType<typeof setInterval> | undefined
let inFlight = false
let requestSerial = 0
let processedEvents = 0
let reloadAfterFlight = false
let disposed = false
let requestController: AbortController | undefined

const runStatus = computed<GenerationSnapshot['status']>(() => props.live ? 'running' : snapshot.value?.status ?? props.liveSpans?.find(span => span.runId === props.runId && span.kind === 'agent')?.status ?? 'running')
const view = computed(() => {
  const storedStatus = snapshot.value?.status
  const incoming = props.live || storedStatus === undefined || storedStatus === 'running' ? props.liveSpans ?? [] : []
  const merged = new Map(spanCache.value)
  const traceId = incoming.find(span => span.runId === props.runId && span.kind === 'agent')?.traceId
    ?? [...merged.values()].find(span => span.runId === props.runId && span.kind === 'agent')?.traceId
  for (const span of incoming) {
    if (span.traceId !== traceId) continue
    merged.delete(span.spanId)
    merged.set(span.spanId, span)
  }
  const sorted = [...merged.values()].sort((a, b) => a.runId === b.runId ? a.sequence - b.sequence || a.startedAt - b.startedAt : a.startedAt - b.startedAt || a.spanId.localeCompare(b.spanId))
  return {
    spans: reconcileTraceSpans(sorted.slice(-MAX_SPANS), props.live ? 'running' : storedStatus ?? runStatus.value, props.runId),
    truncated: truncated.value || merged.size > MAX_SPANS || incoming.length >= MAX_SPANS
  }
})
const spans = computed(() => view.value.spans)
const summary = computed(() => summarizeTrace(spans.value))
const visibleSpans = computed(() => mode.value === 'full' ? spans.value : spans.value.filter(span => span.kind !== 'agent' || span.runId !== props.runId || (span.status !== 'completed' && span.status !== 'running')))
const rowSpans = computed(() => flattenTraceSpans(visibleSpans.value, MAX_SPANS))
const timeline = computed(() => traceTimelineBounds(spans.value, Date.now(), runStatus.value))
const usageComplete = computed(() => traceUsageCompleteness(spans.value))
const runDuration = computed(() => traceRunDuration(spans.value, runStatus.value, Date.now(), props.runId))

function usageNumber(field: keyof typeof usageComplete.value) {
  const value = summary.value[field]
  return `${number(value)}${value !== undefined && (!usageComplete.value[field] || view.value.truncated) ? ` (${t('trace.partial')})` : ''}`
}

function barStyle(span: TraceSpan) {
  const range = Math.max(1, timeline.value.end - timeline.value.start)
  const detachedUnknown = span.detached && span.endedAt === undefined && runStatus.value !== 'running'
  const end = span.endedAt ?? (span.status === 'running' && !detachedUnknown ? timeline.value.end : span.startedAt)
  return {
    left: `${Math.max(0, (span.startedAt - timeline.value.start) / range * 100)}%`,
    width: `${Math.max(0.5, (end - span.startedAt) / range * 100)}%`
  }
}
const legacyEventCount = computed(() => snapshot.value?.eventCount ?? 0)
const legacyEventTypes = computed(() => [...legacyCounts.value.entries()].slice(0, 8).map(([type, count]) => `${type} × ${count}`).join(', '))

const MAX_SPANS = 200
const POLL_INTERVAL_MS = 1200

async function load() {
  if (disposed) return
  if (inFlight) {
    reloadAfterFlight = true
    return
  }
  inFlight = true
  const serial = ++requestSerial
  requestController = new AbortController()
  loading.value = !snapshot.value
  failed.value = false
  try {
    const next = await $chatStore.getRun(props.runId, { signal: requestController.signal })
    if (serial === requestSerial) updateSnapshot(next)
  } catch {
    if (serial === requestSerial) failed.value = true
  } finally {
    if (serial === requestSerial) loading.value = false
    inFlight = false
    if (!disposed && expanded.value && (reloadAfterFlight || serial !== requestSerial)) {
      reloadAfterFlight = false
      void load()
    }
  }
}
function updateSnapshot(next: GenerationSnapshot | undefined) {
  if (!next) {
    snapshot.value = undefined
    spanCache.value = new Map()
    truncated.value = false
    legacyCounts.value = new Map()
    processedEvents = 0
    return
  }
  if (next.journal.length < processedEvents) {
    processedEvents = 0
    truncated.value = false
    spanCache.value = new Map()
    legacyCounts.value = new Map()
  }
  const updatedCounts = new Map(legacyCounts.value)
  for (let index = processedEvents; index < next.journal.length; index++) {
    const type = next.journal[index]!.event.type
    updatedCounts.set(type, (updatedCounts.get(type) ?? 0) + 1)
  }
  legacyCounts.value = updatedCounts
  const changedSpans = readTraceSpans(journalEvents(next.journal, processedEvents), undefined, 10_000)
  const rootTraceId = [...spanCache.value.values()].find(span => span.runId === props.runId && span.kind === 'agent')?.traceId
    ?? changedSpans.find(span => span.runId === props.runId && span.kind === 'agent')?.traceId
  const matchingSpans = changedSpans.filter(span => span.traceId === rootTraceId)
  if (matchingSpans.length) {
    const updated = new Map(spanCache.value)
    for (const span of matchingSpans) {
      updated.delete(span.spanId)
      updated.set(span.spanId, span)
    }
    while (updated.size > MAX_SPANS) {
      truncated.value = true
      updated.delete(updated.keys().next().value!)
    }
    spanCache.value = updated
  }
  processedEvents = next.journal.length
  snapshot.value = { status: next.status, eventCount: next.journal.length }
}

function updatePolling() {
  if (timer) clearInterval(timer)
  timer = undefined
  if (expanded.value && props.live) timer = setInterval(() => void load(), POLL_INTERVAL_MS)
}

watch(expanded, (open) => {
  if (open) void load()
  updatePolling()
})
watch(() => props.live, () => {
  updatePolling()
  if (expanded.value) void load()
})
watch(() => props.runId, () => {
  requestSerial++
  snapshot.value = undefined
  truncated.value = false
  spanCache.value = new Map()
  legacyCounts.value = new Map()
  processedEvents = 0
  if (expanded.value) void load()
})
onBeforeUnmount(() => {
  disposed = true
  requestController?.abort()
  requestSerial++
  if (timer) clearInterval(timer)
})

function duration(span: TraceSpan) {
  if (!span.endedAt && runStatus.value !== 'running') return t('trace.unknown')
  const end = span.endedAt ?? Date.now()
  return formatDuration(Math.max(0, end - span.startedAt))
}

function formatDuration(ms: number) {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`
}

function number(value: number | undefined) {
  return value === undefined ? t('trace.unknown') : new Intl.NumberFormat(intlLocale.value).format(value)
}

function money(currency: string, amount: number) {
  try {
    return new Intl.NumberFormat(intlLocale.value, { style: 'currency', currency, maximumFractionDigits: 6 }).format(amount)
  } catch {
    return t('trace.unknown')
  }
}

function cost(value: typeof summary.value.cost) {
  if (!value) return t('trace.unknown')
  return `${money(value.currency, value.amount)}${value.complete && !view.value.truncated ? '' : ` (${t('trace.partial')})`}`
}

function spanLabel(kind: TraceSpan['kind']) {
  return t(`trace.kind.${kind}`)
}

// 색만으로 상태를 구분하지 않도록 상태마다 모양이 다른 아이콘을 쓴다.
const STATUS_ICONS: Record<ReturnType<typeof traceDisplayStatus>, { name: string; color: string }> = {
  running: { name: 'i-lucide-loader-circle', color: 'text-info' },
  completed: { name: 'i-lucide-circle-check', color: 'text-success' },
  failed: { name: 'i-lucide-circle-x', color: 'text-error' },
  interrupted: { name: 'i-lucide-circle-alert', color: 'text-warning' },
  cancelled: { name: 'i-lucide-circle-minus', color: 'text-muted' },
  unknown: { name: 'i-lucide-circle-help', color: 'text-muted' }
}
function* journalEvents(journal: GenerationSnapshot['journal'], start = 0): IterableIterator<AGUIEvent> {
  for (let index = start; index < journal.length; index++) yield journal[index]!.event
}

</script>

<template>
  <section class="mt-3 rounded-lg border border-default bg-elevated/40 text-sm">
    <button
      type="button"
      class="flex w-full items-center justify-between gap-3 px-3 py-2 text-left"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span class="flex min-w-0 items-center gap-2">
        <UIcon name="i-lucide-chart-no-axes-column-increasing" class="size-4 shrink-0" />
        <span class="font-medium">{{ t('trace.title') }}</span>
        <span class="truncate text-xs text-muted">{{ runId }}</span>
      </span>
      <UIcon :name="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="size-4 shrink-0" />
    </button>

    <div v-if="expanded" class="border-t border-default px-3 py-3">
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span class="text-xs text-muted">{{ t(`trace.status.${live || snapshot || spans.length ? runStatus : 'unknown'}`) }}</span>
        <div class="flex gap-1" role="group" :aria-label="t('trace.detailLevel')">
          <UButton size="xs" :variant="mode === 'simple' ? 'solid' : 'ghost'" :aria-pressed="mode === 'simple'" @click="mode = 'simple'">{{ t('trace.simple') }}</UButton>
          <UButton size="xs" :variant="mode === 'full' ? 'solid' : 'ghost'" :aria-pressed="mode === 'full'" @click="mode = 'full'">{{ t('trace.full') }}</UButton>
        </div>
      </div>

      <p v-if="loading && !snapshot && !spans.length" class="text-muted">{{ t('trace.loading') }}</p>
      <p v-else-if="failed && !spans.length" class="text-error">{{ t('trace.loadFailed') }}</p>
      <template v-else-if="snapshot || spans.length">
        <p v-if="view.truncated" class="mb-2 text-xs text-warning">{{ t('trace.limited', { count: MAX_SPANS }) }}</p>
        <div v-if="spans.length" class="grid grid-cols-2 gap-2 rounded-md bg-muted/30 p-2 sm:grid-cols-4">
          <div><div class="text-xs text-muted">{{ t('trace.input') }}</div><div class="tabular-nums">{{ usageNumber('inputTokens') }}</div></div>
          <div><div class="text-xs text-muted">{{ t('trace.output') }}</div><div class="tabular-nums">{{ usageNumber('outputTokens') }}</div></div>
          <div><div class="text-xs text-muted">{{ t('trace.cacheRead') }}</div><div class="tabular-nums">{{ usageNumber('cacheReadTokens') }}</div></div>
          <div><div class="text-xs text-muted">{{ t('trace.cacheWrite') }}</div><div class="tabular-nums">{{ usageNumber('cacheWriteTokens') }}</div></div>
          <div><div class="text-xs text-muted">{{ t('trace.cost') }}</div><div class="tabular-nums">{{ cost(summary.cost) }}<span v-if="summary.cost" class="ml-1 text-xs text-muted">{{ t(`trace.source.${summary.cost.source}`) }}</span></div></div>
          <div><div class="text-xs text-muted">{{ t('trace.duration') }}</div><div class="tabular-nums">{{ runDuration === undefined ? t('trace.unknown') : formatDuration(runDuration) }}</div></div>
          <div><div class="text-xs text-muted">{{ t('trace.usageSource') }}</div><div>{{ t(`trace.source.${summary.usageSource}`) }}</div></div>
        </div>

        <div v-if="spans.length" class="mt-3 max-h-96 overflow-auto" role="list" :aria-label="t('trace.timeline')">
          <div class="sticky top-0 z-10 mb-2 flex items-center justify-between bg-elevated px-2 py-1 text-xs text-toned">
            <span>{{ t('trace.timeline') }}</span>
            <span>0 ms – {{ formatDuration(timeline.end - timeline.start) }}</span>
          </div>
          <details v-for="{ span, depth } in rowSpans" :key="span.spanId" class="border-l border-default py-1 pl-2" :style="{ marginLeft: `${Math.min(depth, 8) * 12}px` }">
            <summary class="flex cursor-pointer list-none items-center gap-2 rounded px-2 py-1 hover:bg-muted/40">
              <UIcon :name="STATUS_ICONS[traceDisplayStatus(span, runStatus)].name" class="size-3.5 shrink-0" :class="STATUS_ICONS[traceDisplayStatus(span, runStatus)].color" aria-hidden="true" />
              <span class="sr-only">{{ t(`trace.status.${traceDisplayStatus(span, runStatus)}`) }}</span>
              <span class="text-xs text-muted">{{ spanLabel(span.kind) }}</span>
              <span class="min-w-0 flex-1 truncate">{{ span.name }}</span>
              <span class="relative hidden h-3 w-28 shrink-0 overflow-hidden rounded bg-muted/40 sm:block" :title="`${t('trace.started')}: +${formatDuration(span.startedAt - timeline.start)}`">
                <span data-trace-bar class="absolute inset-y-0 min-w-px rounded bg-primary" :style="barStyle(span)" />
              </span>
              <span class="shrink-0 text-xs text-muted tabular-nums">{{ duration(span) }}</span>
            </summary>
            <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-2 py-2 text-xs text-muted">
              <template v-if="mode === 'full'">
                <dt>{{ t('trace.traceId') }}</dt><dd class="break-all">{{ span.traceId }}</dd>
                <dt>{{ t('trace.spanId') }}</dt><dd class="break-all">{{ span.spanId }}</dd>
                <dt v-if="span.parentSpanId">{{ t('trace.parentSpanId') }}</dt><dd v-if="span.parentSpanId" class="break-all">{{ span.parentSpanId }}</dd>
                <dt>{{ t('trace.model') }}</dt><dd>{{ span.model ?? t('trace.unknown') }}</dd>
                <dt v-if="span.toolCallId">{{ t('trace.toolCallId') }}</dt><dd v-if="span.toolCallId">{{ span.toolCallId }}</dd>
                <dt>{{ t('trace.started') }}</dt><dd>{{ new Date(span.startedAt).toLocaleString(intlLocale) }}</dd>
                <dt>{{ t('trace.statusLabel') }}</dt><dd>{{ t(`trace.status.${traceDisplayStatus(span, runStatus)}`) }}</dd>
                <dt>{{ t('trace.ttft') }}</dt><dd>{{ span.ttftMs === undefined ? t('trace.unknown') : formatDuration(span.ttftMs) }}</dd>
                <dt>{{ t('trace.usageSource') }}</dt><dd>{{ span.usage ? t(`trace.source.${span.usage.source}`) : t('trace.unknown') }}</dd>
                <dt>{{ t('trace.input') }}</dt><dd>{{ number(span.usage?.inputTokens) }}</dd>
                <dt>{{ t('trace.output') }}</dt><dd>{{ number(span.usage?.outputTokens) }}</dd>
                <dt>{{ t('trace.cacheRead') }}</dt><dd>{{ number(span.usage?.cacheReadTokens) }}</dd>
                <dt>{{ t('trace.cacheWrite') }}</dt><dd>{{ number(span.usage?.cacheWriteTokens) }}</dd>
                <dt v-if="span.cost">{{ t('trace.cost') }}</dt><dd v-if="span.cost">{{ money(span.cost.currency, span.cost.amount) }} · {{ t(`trace.source.${span.cost.source}`) }}</dd>
                <dt v-if="span.error">{{ t('trace.error') }}</dt><dd v-if="span.error">{{ span.error }}</dd>
              </template>
              <template v-else>
                <dt>{{ t('trace.statusLabel') }}</dt><dd>{{ t(`trace.status.${traceDisplayStatus(span, runStatus)}`) }}</dd>
                <dt>{{ t('trace.duration') }}</dt><dd>{{ duration(span) }}</dd>
                <dt v-if="span.model">{{ t('trace.model') }}</dt><dd v-if="span.model">{{ span.model }}</dd>
                <dt v-if="span.usage?.inputTokens !== undefined">{{ t('trace.input') }}</dt><dd v-if="span.usage?.inputTokens !== undefined">{{ number(span.usage.inputTokens) }}</dd>
                <dt v-if="span.usage?.outputTokens !== undefined">{{ t('trace.output') }}</dt><dd v-if="span.usage?.outputTokens !== undefined">{{ number(span.usage.outputTokens) }}</dd>
              </template>
            </dl>
          </details>
        </div>
        <div v-else class="mt-3 text-muted">
          <p v-if="live">{{ t('trace.loading') }}</p>
          <template v-else>
            <p>{{ t('trace.legacyFallback', { count: legacyEventCount }) }}</p>
            <p v-if="legacyEventTypes" class="mt-1 break-words text-xs">{{ t('trace.legacyEvents', { events: legacyEventTypes }) }}</p>
          </template>
        </div>
      </template>
      <p v-else class="text-muted">{{ t('trace.unavailable') }}</p>
    </div>
  </section>
</template>
