import type { Context } from 'cordis'
import type { LLMSettings } from '@keundal/llm-settings'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { lazyView } from '@keundal/ui-slots'

export const name = 'ui-settings-llm'
export const inject = ['slots', 'chatRuntime']

// 슬롯 등록은 유지하되, 정적 import로 설정 뷰를 초기 번들에 포함하지 않는다.
const LLMSettingsSection = lazyView(() => import('./views/LLMSettings.vue'), [
  'settings', 'model', 'capabilities', 'stop', 'saveSettings'
])

/** Add the LLM provider section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'llm',
    order: 10,
    meta: { label: { en: 'LLM', ko: 'LLM' }, icon: 'i-lucide-plug', group: 'general', query: 'provider' },
    inject: () => ({
      settings: runtime.settings,
      model: runtime.model,
      capabilities: runtime.capabilities,
      // The store exists only in the browser, so it is read when a save starts.
      stop: () => runtime.store.stop(),
      saveSettings: (next: LLMSettings) => runtime.saveSettings(next)
    })
  }, LLMSettingsSection))
}
