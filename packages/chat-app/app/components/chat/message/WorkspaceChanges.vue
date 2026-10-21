<script setup lang="ts">
import { compareLines, type FileChange, type WorkspaceChanges } from '@keundal/workspace-changes/shared'

const props = defineProps<{ changes: WorkspaceChanges }>()
const { t } = useLocale()
const selected = ref<string>()
const mode = ref<'diff' | 'before' | 'after'>('diff')
const file = computed(() => props.changes.files.find(item => item.path === selected.value))
const comparison = computed(() => file.value && !file.value.reason
  ? compareLines(file.value.before ?? '', file.value.after ?? '')
  : undefined)
const totals = computed(() => props.changes.files.reduce((sum, item) => ({
  additions: sum.additions + (item.additions ?? 0),
  deletions: sum.deletions + (item.deletions ?? 0)
}), { additions: 0, deletions: 0 }))
const source = computed(() => (mode.value === 'before' ? file.value?.before : file.value?.after) ?? '')
const modes = ['diff', 'before', 'after'] as const
const kindLabel = (item: FileChange) => t(`changes.${item.kind}`)
const rows = computed(() => {
  const all = comparison.value?.rows ?? []
  const visible = new Set<number>()
  all.forEach((row, index) => {
    if (row.kind !== 'context') {
      for (let i = Math.max(0, index - 3); i <= Math.min(all.length - 1, index + 3); i++) visible.add(i)
    }
  })
  return [...visible].sort((a, b) => a - b).slice(0, 2000).map((index, offset, indices) => ({
    ...all[index]!, gap: index > (indices[offset - 1] ?? -1) + 1
  }))
})
</script>

<template>
  <section class="my-4 overflow-hidden rounded-lg border border-default" :aria-label="t('changes.title')">
    <div class="flex flex-wrap items-center gap-2 bg-elevated/50 px-4 py-3 text-sm">
      <UIcon name="i-lucide-files" class="size-4" />
      <strong>{{ t('changes.title') }}</strong>
      <span>{{ t('changes.count', { count: changes.files.length }) }}</span>
      <span v-if="changes.files.length" class="font-mono">
        <span class="text-success">+{{ totals.additions }}</span>
        <span class="ml-2 text-error">−{{ totals.deletions }}</span>
      </span>
      <span v-if="changes.status === 'partial'" class="text-muted">{{ t('changes.partial') }}</span>
    </div>
    <p v-if="changes.status === 'unavailable'" class="px-4 py-3 text-sm text-muted">
      {{ t('changes.unavailable') }}
    </p>
    <p v-else-if="!changes.files.length" class="px-4 py-3 text-sm text-muted">
      {{ t('changes.empty') }}
    </p>
    <ul v-else class="divide-y divide-default">
      <li v-for="item in changes.files" :key="item.path">
        <button
          type="button"
          class="flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-elevated focus-visible:outline-primary"
          :aria-expanded="selected === item.path"
          @click="selected = selected === item.path ? undefined : item.path"
        >
          <UIcon :name="selected === item.path ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" class="size-4 shrink-0" />
          <span class="min-w-0 flex-1 break-all font-mono">{{ item.path }}</span>
          <span class="shrink-0 text-muted">{{ kindLabel(item) }}</span>
          <span v-if="item.reason" class="text-muted">{{ t(`changes.${item.reason}`) }}</span>
          <span v-else class="shrink-0 font-mono">
            <span class="text-success">+{{ item.additions }}</span>
            <span class="ml-2 text-error">−{{ item.deletions }}</span>
          </span>
        </button>
        <div v-if="selected === item.path" class="border-t border-default">
          <p v-if="item.reason" class="px-4 py-3 text-sm text-muted">
            {{ t(`changes.${item.reason}`) }}
          </p>
          <template v-else>
            <div class="flex gap-1 px-3 py-2">
              <UButton
                v-for="view in modes"
                :key="view"
                size="xs"
                color="neutral"
                :variant="mode === view ? 'soft' : 'ghost'"
                :aria-pressed="mode === view"
                @click="mode = view"
              >
                {{ t(`changes.${view}`) }}
              </UButton>
            </div>
            <p v-if="item.coarse || comparison?.coarse" class="px-4 py-2 text-xs text-muted">
              {{ t('changes.coarse') }}
            </p>
            <div
              v-if="mode === 'diff'"
              class="max-h-96 overflow-auto text-xs"
              tabindex="0"
              :aria-label="t('changes.diff')"
            >
              <table class="w-full border-collapse font-mono">
                <tbody>
                  <template v-for="(row, index) in rows" :key="index">
                    <tr v-if="row.gap">
                      <td colspan="4" class="bg-elevated px-4 text-muted">
                        …
                      </td>
                    </tr>
                    <tr :class="row.kind === 'added' ? 'bg-success/10' : row.kind === 'deleted' ? 'bg-error/10' : ''">
                      <td class="w-10 px-2 text-right align-top text-muted select-none">
                        {{ row.oldLine }}
                      </td>
                      <td class="w-10 px-2 text-right align-top text-muted select-none">
                        {{ row.newLine }}
                      </td>
                      <td class="w-4 align-top select-none">
                        {{ row.kind === 'added' ? '+' : row.kind === 'deleted' ? '−' : ' ' }}
                      </td>
                      <td class="pr-4 whitespace-pre">
                        {{ row.text }}<span v-if="row.noNewline" class="ml-3 text-muted">{{ t('changes.noNewline') }}</span>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
              <p v-if="!rows.length" class="px-4 py-3 text-muted">
                {{ t('changes.noLines') }}
              </p>
              <p v-if="rows.length === 2000" class="px-4 py-3 text-muted">
                {{ t('changes.rowLimit') }}
              </p>
            </div>
            <pre v-else class="max-h-96 overflow-auto px-4 py-3 text-xs" tabindex="0">{{ source || t('changes.emptyFile') }}</pre>
          </template>
        </div>
      </li>
    </ul>
    <p class="border-t border-default px-4 py-2 text-xs text-muted">
      {{ t('changes.coverage') }}
    </p>
  </section>
</template>
