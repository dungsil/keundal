import { z } from 'zod'
import { LLM_PROVIDERS, providerCredentials, providerError, type LLMSettings, type LLMProvider } from './llm-settings'

export const MODEL_CACHE_TTL = 60 * 60 * 1000

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
  const provider = LLM_PROVIDERS.find(item => item.id === value.slice(0, separator))
  let id = value.slice(separator + 1)
  if (!provider || separator < 0 || !id.trim()) throw new Error('Unknown chat model')
  if (value === 'anthropic/claude-haiku-4.5') id = 'claude-haiku-4-5'
  if (value === 'google/gemini-3-flash') id = 'gemini-3-flash-preview'
  return { provider: provider.id, id, value: `${provider.id}/${id}` }
}

/** Credential-scoped cache identity without persisting another copy of the API key. */
async function cacheScope(provider: LLMProvider, settings: LLMSettings) {
  const credentials = providerCredentials(settings, provider)
  const baseURL = (credentials.baseURL || LLM_PROVIDERS.find(item => item.id === provider)!.baseURL).replace(/\/+$/, '')
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([provider, baseURL, credentials.apiKey, Object.entries(credentials.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))])))
  return { scope: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), baseURL, credentials }
}

/** Lists provider metadata only. A listed model may not support this app's tools/streaming API. */
export async function loadModels(provider: LLMProvider, settings: LLMSettings, storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, options: { force?: boolean, signal?: AbortSignal } = {}): Promise<ModelOption[]> {
  const key = `keundal:models:${provider}`
  const { scope, baseURL, credentials } = await cacheScope(provider, settings)
  const { apiKey } = credentials
  options.signal?.throwIfAborted()
  try {
    const cached = cacheSchema.safeParse(JSON.parse(storage.getItem(key) || 'null'))
    if (cached.success && cached.data.scope === scope && !options.force && Date.now() >= cached.data.fetchedAt && Date.now() - cached.data.fetchedAt < MODEL_CACHE_TTL) return cached.data.models
    if (!cached.success || cached.data.scope !== scope) storage.removeItem(key)
  } catch {
    // Disabled/quota-limited storage must not prevent discovery.
  }
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000)
  const headers: Record<string, string> = provider === 'openai'
    ? { authorization: `Bearer ${apiKey}` }
    : provider === 'anthropic'
      ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { 'x-goog-api-key': apiKey }
  Object.assign(headers, credentials.headers)
  const path = provider === 'openai' ? '/models' : provider === 'anthropic' ? '/v1/models' : '/v1beta/models'
  const models = new Map<string, ModelOption>()
  const cursors = new Set<string>()
  let cursor = ''
  try {
    do {
      const url = new URL(`${baseURL}${path}`)
      if (provider === 'anthropic') url.searchParams.set('limit', '1000')
      if (cursor) url.searchParams.set(provider === 'google' ? 'pageToken' : 'after_id', cursor)
      const response = await fetch(url, { headers, signal, cache: 'no-store', credentials: 'omit' })
      if (!response.ok) throw { status: response.status, error: response.status === 400 ? await response.json().catch(() => undefined) : undefined }
      const page = z.object({
        data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional(), max_input_tokens: z.number().positive().nullish(), max_tokens: z.number().positive().nullish() })).optional(),
        models: z.array(z.object({ name: z.string().min(1), displayName: z.string().optional(), supportedGenerationMethods: z.array(z.string()).optional(), inputTokenLimit: z.number().positive().optional(), outputTokenLimit: z.number().positive().optional() })).optional(),
        has_more: z.boolean().optional(), last_id: z.string().nullish(), nextPageToken: z.string().optional()
      }).parse(await response.json())
      if (provider === 'google') {
        if (!page.models) throw new Error('Invalid models response')
        for (const model of page.models) {
          if (!model.supportedGenerationMethods?.includes('generateContent')) continue
          const id = model.name.replace(/^models\//, '')
          models.set(id, { value: `${provider}/${id}`, label: model.displayName || id, icon: 'i-simple-icons-google', contextWindow: model.inputTokenLimit, maxOutputTokens: model.outputTokenLimit })
        }
        cursor = page.nextPageToken || ''
      } else {
        if (!page.data) throw new Error('Invalid models response')
        for (const model of page.data) models.set(model.id, { value: `${provider}/${model.id}`, label: model.display_name || model.id, icon: `i-simple-icons-${provider}`, contextWindow: model.max_input_tokens ?? undefined, maxOutputTokens: model.max_tokens ?? undefined })
        cursor = provider === 'anthropic' && page.has_more ? page.last_id || '' : ''
        if (provider === 'anthropic' && page.has_more && !cursor) throw new Error('Invalid models cursor')
      }
      if (cursor && cursors.has(cursor)) throw new Error('Repeated models cursor')
      cursors.add(cursor)
    } while (cursor)
    options.signal?.throwIfAborted()
    const result = [...models.values()]
    try {
      storage.setItem(key, JSON.stringify({ scope, fetchedAt: Date.now(), models: result }))
    } catch {
      // Discovery still works when localStorage is full or disabled.
    }
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    throw providerError(provider, error, credentials)
  }
}
