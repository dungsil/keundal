import { useLocalStorage } from '@vueuse/core'
import { resolveModel, type ModelOption } from '#shared/utils/models'

export function useModels() {
  const model = useState('chat-model', () => 'anthropic/claude-haiku-4.5')
  useLocalStorage('keundal:model', model, { initOnMounted: true, writeDefaults: false })
  const catalog = useNuxtApp().$modelCatalog
  const models = computed<ModelOption[]>(() => {
    const available = catalog?.models.value ?? []
    const selected = resolveModel(model.value)
    if (available.some(item => item.value === selected.value)) return available
    // Keep saved conversations usable even when discovery fails or a model is no longer listed.
    return [{ value: selected.value, label: selected.id, icon: `i-simple-icons-${selected.provider === 'google' ? 'google' : selected.provider}` }, ...available]
  })
  const selectedModel = computed({
    get: () => resolveModel(model.value).value,
    set: (value) => { model.value = value }
  })

  return {
    models,
    model,
    selectedModel,
    loading: catalog?.loading ?? ref(false),
    error: catalog?.error ?? ref(''),
    refresh: (force = true) => catalog?.refresh(force)
  }
}
