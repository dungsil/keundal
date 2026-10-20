import { onScopeDispose, ref, watch, type Ref } from 'vue'

import { LLM_PROVIDERS, type LLMSettings } from '#shared/utils/llm-settings'
import { loadModels, type ModelOption } from '#shared/utils/models'

/** Owned by the client plugin, shared by the selector and the browser LLM service. */
export function useModelCatalog(settings: Ref<LLMSettings>) {
  const models = ref<ModelOption[]>([])
  const loading = ref(false)
  const error = ref('')
  let active: AbortController | undefined

  async function refresh(force = false) {
    active?.abort()
    const controller = (active = new AbortController())
    loading.value = true
    error.value = ''
    const results = await Promise.all(
      LLM_PROVIDERS.map(async (provider) => {
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
            error.value += `${cause instanceof Error ? cause.message : 'Could not load models'} `
          return models.value.filter(model => model.value.startsWith(`${provider.id}/`))
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
