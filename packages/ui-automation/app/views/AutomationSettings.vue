<script setup lang="ts">
import type { AutomationDefinition, AutomationHistory, AutomationSnapshot, AutomationTrigger } from '@keundal/automation'
import { onActivated, type Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  available: Ref<boolean>
  automations: Ref<AutomationSnapshot[]>
  history: Ref<AutomationHistory[]>
  loading: Ref<boolean>
  loadError: Ref<boolean>
  refresh: () => Promise<void>
  saveAutomation: (id: string, definition: AutomationDefinition) => Promise<void>
  deleteAutomation: (id: string) => Promise<void>
}>()
const { t, intlLocale } = useText()
const editing = ref(false)
const draftId = ref('')
const label = ref('')
const prompt = ref('')
const trigger = ref<AutomationTrigger['type']>('cron')
const expression = ref('0 9 * * *')
const timezone = ref('')
const eventName = ref('')
const enabled = ref(true)
const busy = ref(false)
const error = ref('')
const editorError = ref('')
const deleting = ref<string>()
const filter = ref('all')
const runs = computed(() => props.history.value.filter(run => filter.value === 'all' || run.automationId === filter.value))
const filters = computed(() => [
  { value: 'all', label: t('automation.all') },
  ...props.automations.value.map(item => ({ value: item.id, label: item.label }))
])
const statuses = {
  completed: 'automation.completed', failed: 'automation.failed', interrupted: 'automation.interrupted',
  cancelled: 'automation.cancelled', queued: 'automation.queued', running: 'automation.running',
  dispatching: 'automation.dispatching', submitted: 'automation.submitted', skipped: 'automation.skipped'
} as const
const date = (value: number) => new Date(value).toLocaleString(intlLocale.value)
const status = (run: AutomationHistory) => run.task?.status ?? run.status

onMounted(() => { timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone; void props.refresh() })
onActivated(() => { void props.refresh() })

async function focus(id: string) { await nextTick(); document.getElementById(id)?.focus() }
async function openEditor() {
  draftId.value ||= crypto.randomUUID()
  editorError.value = ''
  deleting.value = undefined
  editing.value = true
  await focus('automation-label')
}
async function closeEditor() { editing.value = false; await focus('automation-add') }

async function save() {
  if (busy.value) return
  editorError.value = ''
  if (!label.value.trim() || !prompt.value.trim() || (trigger.value === 'cron' && (!expression.value.trim() || !timezone.value.trim())) || (trigger.value === 'event' && !eventName.value.trim())) {
    editorError.value = t('automation.invalid')
    return
  }
  const condition: AutomationTrigger = trigger.value === 'cron'
    ? { type: 'cron', expression: expression.value.trim(), timezone: timezone.value.trim() }
    : trigger.value === 'event' ? { type: 'event', name: eventName.value.trim() } : { type: 'webhook' }
  busy.value = true
  try {
    await props.saveAutomation(draftId.value, {
      label: label.value.trim(), enabled: enabled.value, trigger: condition,
      input: { messages: [{ id: crypto.randomUUID(), role: 'user', content: prompt.value.trim() }], state: {}, context: [], tools: [] }
    })
    draftId.value = ''; label.value = ''; prompt.value = ''
    busy.value = false
    await closeEditor()
  } catch {
    editorError.value = t('automation.saveFailed')
  } finally { busy.value = false }
}

async function toggle(item: AutomationSnapshot) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await props.saveAutomation(item.id, { label: item.label, trigger: item.trigger, input: item.input, enabled: !item.enabled }) }
  catch { error.value = t('automation.changeFailed') }
  finally { busy.value = false }
}

async function remove(id: string) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try {
    await props.deleteAutomation(id)
    deleting.value = undefined
    if (filter.value === id) filter.value = 'all'
    busy.value = false
    await focus('automation-add')
  } catch { error.value = t('automation.deleteFailed') }
  finally { busy.value = false }
}
</script>

<template>
  <section class="min-w-0 space-y-5" aria-labelledby="automation-title">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h2 id="automation-title" class="text-lg font-semibold text-highlighted">{{ t('automation.title') }}</h2>
      <div v-if="available.value" class="flex flex-wrap gap-2">
        <UButton :label="t('automation.refresh')" color="neutral" variant="ghost" :disabled="busy || loading.value" @click="refresh" />
        <UButton v-if="!editing" id="automation-add" :label="t('automation.add')" icon="i-lucide-plus" :disabled="busy || loading.value" @click="openEditor" />
      </div>
    </div>
    <p v-if="!available.value" role="status" class="text-sm text-muted">{{ t('automation.unavailable') }}</p>
    <template v-else>
      <p class="text-sm text-muted">{{ t('automation.hostRequired') }}</p>
      <p v-if="loadError.value" role="alert" class="text-sm text-error">{{ t('automation.loadFailed') }}</p>
      <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
      <form v-if="editing" class="space-y-4 rounded-lg border border-default p-4" @submit.prevent="save" @keydown.esc.prevent="!busy && closeEditor()">
        <fieldset :disabled="busy" class="min-w-0 space-y-4">
          <UFormField :label="t('automation.label')" name="automation-label" required>
            <UInput id="automation-label" v-model="label" :maxlength="256" required class="w-full" />
          </UFormField>
          <UFormField :label="t('automation.prompt')" name="automation-prompt" required>
            <UTextarea id="automation-prompt" v-model="prompt" :rows="4" required class="w-full" />
          </UFormField>
          <UFormField :label="t('automation.trigger')" name="automation-trigger">
            <USelect id="automation-trigger" v-model="trigger" :items="(['cron', 'webhook', 'event'] as const).map(value => ({ value, label: t(`automation.${value}`) }))" class="w-full" />
          </UFormField>
          <template v-if="trigger === 'cron'">
            <UFormField :label="t('automation.expression')" name="automation-expression" required>
              <UInput id="automation-expression" v-model="expression" required class="w-full" />
            </UFormField>
            <UFormField :label="t('automation.timezone')" name="automation-timezone" required>
              <UInput id="automation-timezone" v-model="timezone" required class="w-full" />
            </UFormField>
          </template>
          <UFormField v-if="trigger === 'event'" :label="t('automation.eventName')" name="automation-event" required>
            <UInput id="automation-event" v-model="eventName" :maxlength="256" required class="w-full" />
          </UFormField>
          <UCheckbox v-model="enabled" :label="t('automation.enabled')" />
        </fieldset>
        <p v-if="editorError" role="alert" class="break-words text-sm text-error">{{ editorError }}</p>
        <div class="flex justify-end gap-2">
          <UButton :label="t('automation.cancel')" color="neutral" variant="outline" :disabled="busy" @click="closeEditor" />
          <UButton type="submit" :label="t('automation.save')" :loading="busy" />
        </div>
      </form>
      <p v-if="loading.value && !automations.value.length" role="status" class="text-sm text-muted">{{ t('automation.loading') }}</p>
      <p v-else-if="!automations.value.length && !loadError.value" class="text-sm text-muted">{{ t('automation.empty') }}</p>
      <article v-for="item in automations.value" :key="item.id" class="min-w-0 space-y-3 rounded-lg border border-default p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="break-words font-medium text-highlighted">{{ item.label }}</h3>
          <UBadge :color="item.enabled ? 'success' : 'neutral'" variant="subtle">{{ t(item.enabled ? 'automation.enabled' : 'automation.disabled') }}</UBadge>
        </div>
        <p class="break-all text-sm text-muted">{{ t(`automation.${item.trigger.type}`) }}<template v-if="item.trigger.type === 'cron'"> · {{ item.trigger.expression }} · {{ item.trigger.timezone }}</template><template v-if="item.trigger.type === 'event'"> · {{ item.trigger.name }}</template></p>
        <p class="text-sm">{{ t('automation.next') }}: {{ !item.enabled ? t('automation.disabled') : item.nextRunAt ? date(item.nextRunAt) : t('automation.waiting') }}</p>
        <p class="break-all font-mono text-xs text-muted">{{ item.id }}</p>
        <div v-if="deleting === item.id" class="space-y-3" @keydown.esc.prevent="deleting = undefined; focus(`automation-delete-${item.id}`)">
          <p class="text-sm">{{ t('automation.confirmDelete') }}</p>
          <div class="flex gap-2">
            <UButton :id="`automation-confirm-${item.id}`" :label="t('automation.delete')" color="error" :disabled="busy" @click="remove(item.id)" />
            <UButton :label="t('automation.cancel')" color="neutral" variant="outline" :disabled="busy" @click="deleting = undefined; focus(`automation-delete-${item.id}`)" />
          </div>
        </div>
        <div v-else class="flex flex-wrap gap-2">
          <UButton :label="t(item.enabled ? 'automation.disable' : 'automation.enable')" :aria-label="`${item.label}: ${t(item.enabled ? 'automation.disable' : 'automation.enable')}`" color="neutral" variant="outline" :disabled="busy" @click="toggle(item)" />
          <UButton :label="t('automation.history')" color="neutral" variant="ghost" @click="filter = item.id; focus('automation-history')" />
          <UButton :id="`automation-delete-${item.id}`" :label="t('automation.delete')" :aria-label="`${item.label}: ${t('automation.delete')}`" color="error" variant="ghost" :disabled="busy" @click="deleting = item.id; focus(`automation-confirm-${item.id}`)" />
        </div>
      </article>
      <section class="min-w-0 space-y-4 border-t border-default pt-5" aria-labelledby="automation-history">
        <h3 id="automation-history" tabindex="-1" class="font-semibold text-highlighted">{{ t('automation.history') }}</h3>
        <USelect v-model="filter" :aria-label="t('automation.history')" :items="filters" class="w-full" />
        <p v-if="!runs.length" class="text-sm text-muted">{{ t('automation.noRuns') }}</p>
        <article v-for="run in runs" :key="run.id" class="min-w-0 space-y-2 rounded-lg border border-default p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h4 class="break-all text-sm font-medium">{{ run.task?.label ?? automations.value.find(item => item.id === run.automationId)?.label ?? run.automationId }}</h4>
            <UBadge :color="status(run) === 'completed' ? 'success' : ['failed', 'interrupted'].includes(status(run)) ? 'error' : 'neutral'" variant="subtle">{{ t(statuses[status(run)]) }}</UBadge>
          </div>
          <p class="text-xs text-muted">{{ date(run.createdAt) }}</p>
          <p v-if="run.task?.error || run.error" class="whitespace-pre-wrap break-words text-sm text-error">{{ run.task?.error || run.error }}</p>
          <details v-if="run.task?.content" class="text-sm">
            <summary class="cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-primary">{{ t('automation.result') }}</summary>
            <p class="mt-2 whitespace-pre-wrap break-words">{{ run.task.content }}</p>
          </details>
        </article>
      </section>
    </template>
  </section>
</template>
