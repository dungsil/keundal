import type { Context } from 'cordis'
import type { ModelRecoveryPolicy } from '@keundal/chat/model-preferences'
import type {} from '@keundal/ui/app/contracts/composer.ts'
import type {} from '@keundal/ui-runtime'
import type {} from '@keundal/ui/app/contracts/settings.ts'
import { localizedText } from '@keundal/ui/app/utils/locale.ts'

import { messages } from './locale'
import ModelSelect from './views/ModelSelect.vue'
import ModelSettings from './views/ModelSettings.vue'
import ReasoningSelect from './views/ReasoningSelect.vue'

export const name = 'ui-model-selection'
export const inject = ['slots', 'chatRuntime']

export const metadata = {
  name: { en: 'Model selection', ko: '모델 선택' },
  description: {
    en: 'Provides model and reasoning selection, default models, and model recovery settings.',
    ko: '모델·추론 수준 선택과 기본 모델, 모델 복구 설정을 제공합니다.'
  }
}

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
      modelRecovery: runtime.modelRecovery,
      saveModelRecovery: (value: ModelRecoveryPolicy) => runtime.saveModelRecovery(value),
      loading: runtime.modelsLoading,
      modelError: runtime.modelsError,
      refresh: (force?: boolean) => runtime.refreshModels(force)
    })
  }, ModelSettings))
}
