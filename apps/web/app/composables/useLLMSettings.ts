import { defaultLLMSettings, LLM_PROVIDERS, providerCredentials, type LLMProvider } from '#shared/utils/llm-settings'

export function useLLMSettings() {
  // The client plugin owns one shared ref; SSR only receives empty defaults.
  const settings = useNuxtApp().$llmSettings ?? ref(defaultLLMSettings())
  // Only this non-sensitive UI flag belongs in Nuxt state, never the credentials.
  const open = useState('llm-settings-open', () => false)
  const requestedProvider = useState<LLMProvider | null>('llm-settings-provider', () => null)
  function ensureConfigured(model: string) {
    if (useNuxtApp().$remoteAgent) return true
    const provider = LLM_PROVIDERS.find(item => model.startsWith(`${item.id}/`))
    try {
      if (!provider) return false
      providerCredentials(settings.value, provider.id)
      return true
    } catch {
      requestedProvider.value = provider?.id ?? null
      open.value = true
      return false
    }
  }
  return { settings, open, requestedProvider, ensureConfigured }
}
