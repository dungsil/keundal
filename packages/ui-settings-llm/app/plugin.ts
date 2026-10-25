import type { Context } from 'cordis'
import type { LLMSettings } from '@keundal/llm-settings'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import LLMSettingsSection from './views/LLMSettings.vue'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'
import { messages } from './locale'
import SystemPromptSettings from './views/SystemPromptSettings.vue'

export const name = 'ui-settings-llm'
export const inject = ['slots', 'chatRuntime']

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
      saveSettings: (next: LLMSettings) => runtime.saveSettings(next),
      loadModels: (provider: string, settings: LLMSettings) => runtime.platform.loadModels(provider, settings, globalThis.localStorage as Storage)
    })
  }, LLMSettingsSection))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'system-prompt',
    order: 25,
    meta: { label: localizedText(messages, 'prompt.title'), icon: 'i-lucide-text-cursor-input', group: 'general' },
    inject: () => ({
      systemPrompt: runtime.systemPrompt,
      saveSystemPrompt: (value: string) => runtime.saveSystemPrompt(value)
    })
  }, SystemPromptSettings))
}
