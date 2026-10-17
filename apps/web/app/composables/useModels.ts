import { useLocalStorage } from '@vueuse/core'
import { MODELS } from '#shared/utils/models'

export function useModels() {
  const model = useLocalStorage('keundal:model', 'anthropic/claude-haiku-4.5', { initOnMounted: true, writeDefaults: false })

  return {
    models: MODELS,
    model
  }
}
