import { resolveModel, type ModelOption } from '../../shared/utils/models'
import { FALLBACK_MODEL } from '../../shared/utils/model-preferences'
import { createModelSelection } from '../../shared/utils/model-selection'

export function useModels() {
  const { t } = useLocale()
  const toast = useToast()
  const model = useState('chat-model', () => FALLBACK_MODEL)
  const defaultModel = useState('default-model', () => '')
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
  const selection = createModelSelection({
    model,
    defaultModel,
    switching,
    error: selectionError,
    storage: {
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: key => localStorage.removeItem(key)
    },
    selectModel,
    canSelectDefault: value => !remoteModels || remoteModels.value.some(item => item.value === value),
    onError: () => {
      selectionError.value = t('model.switchFailed')
      toast.add({ description: selectionError.value, icon: 'i-lucide-alert-circle', color: 'error' })
    }
  })

  return {
    models,
    model,
    defaultModel,
    ...selection,
    switching,
    loading: computed(() => switching.value || !!catalog?.loading.value),
    error: computed(() => selectionError.value || catalog?.error.value || ''),
    refresh: (force = true) => catalog?.refresh(force)
  }
}
