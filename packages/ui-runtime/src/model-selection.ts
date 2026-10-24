import { saveDefaultModel } from '@keundal/chat/model-preferences'
import { resolveModel } from '@keundal/chat/models'
import { computed, type Ref } from 'vue'

export function createModelSelection(options: {
  model: Ref<string>
  defaultModel: Ref<string>
  switching: Ref<boolean>
  error: Ref<string>
  storage: Pick<Storage, 'setItem' | 'removeItem'>
  selectModel?: (value: string) => Promise<void>
  canSelectDefault: (value: string) => boolean
  onError: () => void
}) {
  const { model, defaultModel, switching, error } = options
  const selectedModel = computed({
    get: () => resolveModel(model.value).value,
    set: (value: string) => {
      if (switching.value) return
      error.value = ''
      if (!options.selectModel) {
        model.value = value
        return
      }
      switching.value = true
      void options
        .selectModel(value)
        .then(() => {
          model.value = value
        })
        .catch(() => {
          options.onError()
        })
        .finally(() => {
          switching.value = false
        })
    }
  })

  return {
    selectedModel,
    saveDefaultModel: (value: string) => {
      defaultModel.value = saveDefaultModel(options.storage, value)
    },
    applyDefaultModel: () => {
      if (defaultModel.value && defaultModel.value !== model.value && options.canSelectDefault(defaultModel.value))
        selectedModel.value = defaultModel.value
    }
  }
}
