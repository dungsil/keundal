import { useLocalStorage } from '@vueuse/core'

import { resolveModel, type ModelOption } from '#shared/utils/models'

export function useModels() {
  const { t } = useLocale()
  const toast = useToast()
  const model = useState('chat-model', () => 'anthropic/claude-haiku-4.5')
  useLocalStorage('keundal:model', model, { initOnMounted: true, writeDefaults: false })
  const { $modelCatalog: catalog, $remoteModels: remoteModels, $selectModel: selectModel } = useNuxtApp()
  const switching = useState('model-switching', () => false)
  const selectionError = useState('model-selection-error', () => '')
  if (remoteModels) {
    watch(remoteModels, (available) => {
      if (available.length && !available.some(item => item.value === model.value)) model.value = available[0]!.value
    }, { immediate: true })
  }
  const models = computed<ModelOption[]>(() => {
    if (remoteModels) return remoteModels.value
    const available = catalog?.models.value ?? []
    const selected = resolveModel(model.value)
    if (available.some(item => item.value === selected.value)) return available
    // Keep saved conversations usable even when discovery fails or a model is no longer listed.
    return [
      {
        value: selected.value,
        label: selected.id,
        icon: `i-simple-icons-${selected.provider === 'google' ? 'google' : selected.provider}`
      },
      ...available
    ]
  })
  const selectedModel = computed({
    get: () => resolveModel(model.value).value,
    set: (value) => {
      if (switching.value) return
      selectionError.value = ''
      if (!selectModel) {
        model.value = value
        return
      }
      switching.value = true
      void selectModel(value).then(() => {
        model.value = value
      }).catch(() => {
        selectionError.value = t('model.switchFailed')
        toast.add({ description: selectionError.value, icon: 'i-lucide-alert-circle', color: 'error' })
      }).finally(() => {
        switching.value = false
      })
    }
  })

  return {
    models,
    model,
    selectedModel,
    switching,
    loading: computed(() => switching.value || !!catalog?.loading.value),
    error: computed(() => selectionError.value || catalog?.error.value || ''),
    refresh: (force = true) => catalog?.refresh(force)
  }
}
