import { z } from 'zod'

export const LLM_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', model: 'claude-haiku-4-5', baseURL: 'https://api.anthropic.com' },
  { id: 'google', label: 'Google Gemini', model: 'gemini-3-flash-preview', baseURL: 'https://generativelanguage.googleapis.com' },
  { id: 'openai', label: 'OpenAI', model: 'gpt-5-nano', baseURL: 'https://api.openai.com/v1' }
] as const

export type LLMProvider = typeof LLM_PROVIDERS[number]['id']

export const providerSettingsSchema = z.object({
  apiKey: z.string().trim().max(4096).regex(/^[^\r\n]*$/, 'API key must not contain line breaks'),
  baseURL: z.string().trim().refine((value) => {
    if (!value) return true
    try {
      const url = new URL(value)
      const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      return (url.protocol === 'https:' || (local && url.protocol === 'http:'))
        && !url.username && !url.password && !url.search && !url.hash
    } catch {
      return false
    }
  }, 'Use an HTTPS API URL without credentials, query or fragment (HTTP is allowed for localhost)')
})

export type ProviderSettings = z.infer<typeof providerSettingsSchema>
export type LLMSettings = Record<LLMProvider, ProviderSettings>

export function defaultLLMSettings(): LLMSettings {
  return { anthropic: { apiKey: '', baseURL: '' }, google: { apiKey: '', baseURL: '' }, openai: { apiKey: '', baseURL: '' } }
}

export function providerCredentials(settings: LLMSettings, provider: LLMProvider) {
  const parsed = providerSettingsSchema.safeParse(settings[provider])
  if (!parsed.success) throw new Error(`Open LLM settings and check the ${provider} configuration`)
  if (!parsed.data.apiKey) throw new Error(`Open LLM settings and add your ${provider} API key`)
  return { apiKey: parsed.data.apiKey, baseURL: parsed.data.baseURL || undefined }
}

/** Provider errors can echo credentials. Never persist or display their raw message/cause. */
export function providerError(provider: LLMProvider, error: unknown): Error {
  const status = error && typeof error === 'object' && 'status' in error && typeof error.status === 'number' ? ` (HTTP ${error.status})` : ''
  return new Error(`${provider} request failed${status}. Check your API key, API URL and the endpoint's browser CORS permissions.`)
}
