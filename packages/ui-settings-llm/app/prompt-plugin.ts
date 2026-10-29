import type { Context } from 'cordis'
import type { PromptPresetSettings } from '@keundal/chat'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'
import { messages } from './locale'
import SystemPromptSettings from './views/SystemPromptSettings.vue'

export const name = 'ui-prompt-presets'
export const inject = ['slots', 'chatRuntime']

export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'system-prompt',
    order: 25,
    meta: { label: localizedText(messages, 'prompt.title'), icon: 'i-lucide-text-cursor-input', group: 'general' },
    inject: () => ({
      promptPresets: runtime.promptPresets,
      savePromptPresets: (value: PromptPresetSettings) => runtime.savePromptPresets(value)
    })
  }, SystemPromptSettings))
}
