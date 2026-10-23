import type { ModelOption } from '@keundal/chat/models'
import type { ModelLoader } from '@keundal/chat/platform'
import { configuredProviders, type LLMSettings } from '@keundal/llm-settings'
import { onScopeDispose, ref, watch, type Ref } from 'vue'

export interface ModelCatalog {
  models: Ref<ModelOption[]>
  loading: Ref<boolean>
  error: Ref<string>
  refresh(force?: boolean): Promise<void>
}

/** Owned by the chat runtime, shared by the selector and the browser LLM service. */
export function useModelCatalog(
  settings: Ref<LLMSettings>,
  loadModels: ModelLoader,
  loadErrorMessage = () => 'Could not load models'
): ModelCatalog {
  const models = ref<ModelOption[]>([])
  const loading = ref(false)
  const error = ref('')
  let active: AbortController | undefined
  let previousIds: string[] = []

  async function refresh(force = false) {
    active?.abort()
    const controller = (active = new AbortController())
    const ids = Object.keys(settings.value)
    for (const id of previousIds.filter((id) => !ids.includes(id))) {
      try {
        localStorage.removeItem(`keundal:models:${id}`)
      } catch {
        /* Storage may be unavailable. */
      }
    }
    previousIds = ids
    loading.value = true
    error.value = ''
    const results = await Promise.all(
      configuredProviders(settings.value).map(async (provider) => {
        const configured = settings.value[provider.id]
        if (!configured?.apiKey && !configured?.baseURL && !Object.keys(configured?.headers ?? {}).length) {
          try {
            localStorage.removeItem(`keundal:models:${provider.id}`)
          } catch {
            // Storage may be unavailable.
          }
          return []
        }
        try {
          return await loadModels(provider.id, settings.value, localStorage, { force, signal: controller.signal })
        } catch (cause) {
          if (!controller.signal.aborted)
            error.value += `${cause instanceof Error ? cause.message : loadErrorMessage()} `
          return models.value.filter((model) => model.value.startsWith(`${provider.id}/`))
        }
      })
    )
    if (controller.signal.aborted) return
    models.value = results.flat()
    loading.value = false
  }

  watch(
    settings,
    () => {
      models.value = []
      void refresh()
    },
    { deep: true, immediate: true }
  )
  onScopeDispose(() => active?.abort())
  return { models, loading, error, refresh }
}
