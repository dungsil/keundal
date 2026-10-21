import { defaultLLMSettings, configuredProviders, providerCredentials } from '../../shared/utils/llm-settings'

export function useLLMSettings() {
  // The client plugin owns one shared ref; SSR only receives empty defaults.
  const settings = useNuxtApp().$llmSettings ?? ref(defaultLLMSettings())
  const route = useRoute()
  function ensureConfigured(model: string) {
    if (useNuxtApp().$remoteAgent) return true
    const provider = configuredProviders(settings.value).find(item => model.startsWith(`${item.id}/`))
    if (!provider) return false
    try {
      providerCredentials(settings.value, provider.id)
      return true
    } catch {
      void navigateTo({
        path: '/settings',
        query: { provider: provider.id, returnTo: route.path }
      })
      return false
    }
  }
  return { settings, ensureConfigured }
}
