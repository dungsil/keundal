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
  let pending: Promise<void> | undefined
  let pendingForce = false
  let previous: Partial<LLMSettings> = {}
  let identity = ''

  function refresh(force = false): Promise<void> {
    // Snapshot before awaiting: Vue settings can change while a provider is responding.
    const nextIdentity = JSON.stringify(settings.value)
    if (pending && identity === nextIdentity && (!force || pendingForce)) return pending
    active?.abort()
    const controller = (active = new AbortController())
    const snapshot: LLMSettings = JSON.parse(nextIdentity)
    identity = nextIdentity
    const ids = Object.keys(snapshot)
    const unchanged = ids.filter((id) => JSON.stringify(previous[id]) === JSON.stringify(snapshot[id]))
    models.value = models.value.filter((model) => unchanged.includes(model.value.split('/')[0]!))
    for (const id of Object.keys(previous).filter((id) => !unchanged.includes(id))) {
      try {
        localStorage.removeItem(`keundal:models:${id}`)
      } catch {
        /* Storage may be unavailable. */
      }
    }
    previous = snapshot
    loading.value = true
    error.value = ''
    const results = new Map<string, ModelOption[]>()
    for (const id of ids)
      results.set(
        id,
        models.value.filter((model) => model.value.startsWith(`${id}/`))
      )
    const publish = () => {
      models.value = ids.flatMap((id) => results.get(id) ?? [])
    }
    const work = Promise.all(
      configuredProviders(snapshot).map(async (provider) => {
        const configured = snapshot[provider.id]
        if (!configured?.apiKey && !configured?.baseURL && !Object.keys(configured?.headers ?? {}).length) {
          try {
            localStorage.removeItem(`keundal:models:${provider.id}`)
          } catch {
            /* Storage may be unavailable. */
          }
          results.set(provider.id, [])
          return
        }
        try {
          const available = await loadModels(provider.id, snapshot, localStorage, { force, signal: controller.signal })
          if (controller.signal.aborted) return
          results.set(provider.id, available)
        } catch (cause) {
          if (controller.signal.aborted) return
          error.value += `${cause instanceof Error ? cause.message : loadErrorMessage()} `
          // The loader owns stale-cache expiry; never retain failed results indefinitely.
          results.set(provider.id, [])
        }
        publish()
      })
    )
      .then(() => {
        if (controller.signal.aborted) return
        publish()
        loading.value = false
      })
      .finally(() => {
        if (active === controller) pending = undefined
      })
    pendingForce = force
    pending = work
    return work
  }

  watch(
    settings,
    () => {
      void refresh()
    },
    { deep: true, immediate: true, flush: 'sync' }
  )
  onScopeDispose(() => active?.abort())
  return { models, loading, error, refresh }
}
