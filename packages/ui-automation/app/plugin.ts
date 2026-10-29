import type { AutomationDefinition, AutomationHistory, AutomationSnapshot } from '@keundal/automation'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import type {} from '@keundal/ui/app/contracts/layout.ts'
import { lazyView } from '@keundal/ui-slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'
import type { Context } from 'cordis'
import { shallowRef, ref } from 'vue'

import { messages } from './locale'

const AutomationSettings = lazyView(() => import('./views/AutomationSettings.vue'), [
  'available', 'automations', 'history', 'loading', 'loadError', 'refresh', 'saveAutomation', 'deleteAutomation'
])
const AutomationNotifications = lazyView(() => import('./views/AutomationNotifications.vue'), [
  'available', 'automations', 'history', 'refresh'
])

export const name = 'ui-automation'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Automation settings', ko: '자동화 설정' },
  description: {
    en: 'Manages scheduled automations, execution history, and notifications.',
    ko: '예약 자동화와 실행 이력, 알림을 관리합니다.'
  }
}

export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  const automations = shallowRef<AutomationSnapshot[]>([])
  const history = shallowRef<AutomationHistory[]>([])
  const loading = ref(false)
  const loadError = ref(false)
  let pending: Promise<void> | undefined
  let disposed = false
  ctx.effect(() => () => { disposed = true })

  function refresh(): Promise<void> {
    if (pending) return pending
    if (disposed || !runtime.automationsAvailable.value) return Promise.resolve()
    loading.value = true
    pending = (async () => {
      try {
        const [definitions, runs] = await Promise.all([runtime.listAutomations(), runtime.automationHistory()])
        if (disposed) return
        automations.value = definitions
        history.value = runs.toSorted((a, b) => b.createdAt - a.createdAt)
        loadError.value = false
      } catch {
        if (!disposed) loadError.value = true
      } finally {
        loading.value = false
        pending = undefined
      }
    })()
    return pending
  }

  const shared = () => ({ available: runtime.automationsAvailable, automations, history, refresh })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', key: 'automation', order: 33,
    meta: { label: localizedText(messages, 'automation.title'), icon: 'i-lucide-calendar-clock', group: 'general' },
    inject: () => ({
      ...shared(), loading, loadError,
      saveAutomation: async (id: string, definition: AutomationDefinition) => {
        await runtime.saveAutomation(id, definition)
        await pending
        await refresh()
      },
      deleteAutomation: async (id: string) => {
        await runtime.deleteAutomation(id)
        await pending
        await refresh()
      }
    })
  }, AutomationSettings))
  ctx.slots.inject('layout.overlay', () => ctx.slots.register({
    name: 'layout.overlay', id: 'automation-notifications', inject: shared
  }, AutomationNotifications))
}
