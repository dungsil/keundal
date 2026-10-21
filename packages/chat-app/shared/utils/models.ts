import { z } from 'zod'
import { LLM_PROVIDERS, providerCredentials, providerError, providerType, type LLMSettings } from './llm-settings'

export const MODEL_CACHE_TTL = 60 * 60 * 1000
const modelLoaders = {
  openai: () => import('@keundal/plugin-llm-openai').then(module => module.listOpenAIModels),
  anthropic: () => import('@keundal/plugin-llm-anthropic').then(module => module.listAnthropicModels),
  google: () => import('@keundal/plugin-llm-gemini').then(module => module.listGeminiModels)
}

const modelSchema = z.object({
  value: z.string().min(1),
  label: z.string().min(1),
  icon: z.string(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional()
})
export type ModelOption = z.infer<typeof modelSchema>
const cacheSchema = z.object({ scope: z.string(), fetchedAt: z.number(), models: z.array(modelSchema) })

/** Preserve model aliases already saved in conversations, but accept discovered IDs verbatim. */
export function resolveModel(value: string) {
  const separator = value.indexOf('/')
  const configuration = value.slice(0, separator)
  const provider = providerType(configuration)
  let id = value.slice(separator + 1)
  if (!provider || separator < 0 || !id.trim()) throw new Error('Unknown chat model')
  if (value === 'anthropic/claude-haiku-4.5') id = 'claude-haiku-4-5'
  if (value === 'google/gemini-3-flash') id = 'gemini-3-flash-preview'
  return { provider, configuration, id, value: `${configuration}/${id}` }
}

/** Credential-scoped cache identity without persisting another copy of the API key. */
async function cacheScope(provider: string, settings: LLMSettings) {
  const credentials = providerCredentials(settings, provider)
  const baseURL = (credentials.baseURL || LLM_PROVIDERS.find(item => item.id === providerType(provider))!.baseURL).replace(/\/+$/, '')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([provider, settings[provider]?.name, baseURL, credentials.apiKey, Object.entries(credentials.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))])))
  return { scope: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), credentials }
}

/** Lists provider metadata only. A listed model may not support this app's tools/streaming API. */
export async function loadModels(provider: string, settings: LLMSettings, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, options: { force?: boolean, signal?: AbortSignal } = {}): Promise<ModelOption[]> {
  const key = `keundal:models:${provider}`
  const { scope, credentials } = await cacheScope(provider, settings)
  options.signal?.throwIfAborted()
  try {
    const cached = cacheSchema.safeParse(JSON.parse(storage.getItem(key) || 'null'))
    if (cached.success && cached.data.scope === scope && !options.force && Date.now() >= cached.data.fetchedAt && Date.now() - cached.data.fetchedAt < MODEL_CACHE_TTL) return cached.data.models
    if (!cached.success || cached.data.scope !== scope) storage.removeItem(key)
  } catch {
    // Disabled/quota-limited storage must not prevent discovery.
  }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  try {
    const load = await modelLoaders[providerType(provider)]()
    options.signal?.throwIfAborted()
    const models = await load({ ...credentials, dangerouslyAllowBrowser: true }, { signal })
    options.signal?.throwIfAborted()
    const result = models.map(model => ({
      value: `${provider}/${model.id}`,
      label: provider.includes('@') || settings[provider]?.name ? `${model.name} · ${settings[provider]!.name || provider}` : model.name,
      icon: `i-simple-icons-${providerType(provider)}`,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens
    }))
    try {
      storage.setItem(key, JSON.stringify({ scope, fetchedAt: Date.now(), models: result }))
    } catch {
      // Discovery still works when localStorage is full or disabled.
    }
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    throw providerError(providerType(provider), error, credentials)
  }
}
