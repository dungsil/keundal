<script setup lang="ts">
import type { AutomationHistory, AutomationSnapshot } from '@keundal/automation'
import type { Ref } from 'vue'

import { useText } from '../locale'

const props = defineProps<{
  available: Ref<boolean>
  automations: Ref<AutomationSnapshot[]>
  history: Ref<AutomationHistory[]>
  refresh: () => Promise<void>
}>()
const { t } = useText()
const toast = useToast()
const seen = new Map<string, string>()
let initialized = false
let stopped = false
let timer: ReturnType<typeof setTimeout> | undefined

// Seed from the first successful snapshot, rather than replaying old notifications on every app launch.
watch(() => props.history.value, runs => {
  for (const run of runs) {
    const status = run.task?.status ?? run.status
    if (initialized && seen.get(run.id) !== status && ['completed', 'failed', 'interrupted'].includes(status)) {
      toast.add({
        title: t('automation.notice', { name: run.task?.label ?? props.automations.value.find(item => item.id === run.automationId)?.label ?? run.automationId }),
        description: t(`automation.${status as 'completed' | 'failed' | 'interrupted'}`),
        color: status === 'completed' ? 'success' : 'error',
        duration: 8000,
        actions: [{ label: t('automation.open'), onClick: () => navigateTo('/settings/automation') }]
      })
    }
    seen.set(run.id, status)
  }
  initialized = true
})

async function poll() {
  if (stopped) return
  if (props.available.value) await props.refresh()
  if (!stopped) timer = setTimeout(poll, 5000)
}
onMounted(poll)
onBeforeUnmount(() => { stopped = true; clearTimeout(timer) })
</script>

<template>
  <span class="hidden" aria-hidden="true" />
</template>
