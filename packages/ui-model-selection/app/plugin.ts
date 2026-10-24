import type { Context } from 'cordis'
import type {} from '@keundal/ui-composer/slots'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui-settings/slots'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'
import ModelSelect from './views/ModelSelect.vue'
import ModelSettings from './views/ModelSettings.vue'
import ReasoningSelect from './views/ReasoningSelect.vue'

export const name = 'ui-model-selection'
export const inject = ['slots', 'chatRuntime']

/** Add the model and reasoning pickers to the composer and the model section to the settings page. */
export function apply(ctx: Context) {
  const runtime = ctx.chatRuntime
  ctx.slots.inject('composer.actions', () => [
    ctx.slots.register({
      name: 'composer.actions',
      id: 'model',
      order: 10,
      inject: () => ({
        selectedModel: runtime.selectedModel,
        models: runtime.models,
        loading: runtime.modelsLoading,
        switching: runtime.switching,
        error: runtime.modelsError,
        refresh: (force?: boolean) => runtime.refreshModels(force)
      })
    }, ModelSelect),
    ctx.slots.register({
      name: 'composer.actions',
      id: 'reasoning',
      order: 20,
      inject: () => ({ reasoning: runtime.reasoning, reasoningLevels: runtime.reasoningLevels })
    }, ReasoningSelect)
  ])
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    key: 'models',
    order: 20,
    meta: { label: localizedText(messages, 'model.defaultTitle'), icon: 'i-lucide-bot', group: 'general' },
    inject: () => ({
      models: runtime.models,
      defaultModel: runtime.defaultModel,
      titleModel: runtime.titleModel,
      saveDefaultModel: (value: string) => runtime.saveDefaultModel(value),
      saveTitleModel: (value: string) => runtime.saveTitleModel(value),
      loading: runtime.modelsLoading,
      modelError: runtime.modelsError,
      refresh: (force?: boolean) => runtime.refreshModels(force)
    })
  }, ModelSettings))
}
