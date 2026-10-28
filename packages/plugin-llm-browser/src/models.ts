import { modelSchema, type ModelOption } from '@keundal/chat/models'
export { resolveModel, type ModelOption } from '@keundal/chat/models'
const cacheSchema = z.object({ scope: z.string(), fetchedAt: z.number(), models: z.array(modelSchema) })
import {
  LLM_PROVIDERS,
  providerCredentials,
  providerError,
  providerIcon,
  providerType,
  type LLMSettings
} from '@keundal/llm-settings'
import { z } from 'zod'

export const MODEL_CACHE_TTL = 60 * 60 * 1000
export const MODEL_CACHE_MAX_AGE = 24 * MODEL_CACHE_TTL
// Only write ordering is shared, scoped to a storage instance; no credentials or results.
const latestRequests = new WeakMap<object, Map<string, symbol>>()
const modelLoaders = {
  openai: () => import('@keundal/plugin-llm-openai').then((module) => module.listOpenAIModels),
  'openai-chat': () => import('@keundal/plugin-llm-openai-chat').then((module) => module.listOpenAIChatModels),
  anthropic: () => import('@keundal/plugin-llm-anthropic').then((module) => module.listAnthropicModels),
  google: () => import('@keundal/plugin-llm-gemini').then((module) => module.listGeminiModels)
}

/** Credential-scoped cache identity without persisting another copy of the API key. */
async function cacheScope(provider: string, settings: LLMSettings) {
  const credentials = providerCredentials(settings, provider)
  const baseURL = (
    credentials.baseURL || LLM_PROVIDERS.find((item) => item.id === providerType(provider))!.baseURL
  ).replace(/\/+$/, '')
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([
        provider,
        settings[provider]?.name,
        baseURL,
        credentials.apiKey,
        Object.entries(credentials.headers ?? {}).sort(([a], [b]) => a.localeCompare(b))
      ])
    )
  )
  return {
    scope: Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
    credentials
  }
}

/** Lists provider metadata only. A listed model may not support this app's tools/streaming API. */
export async function loadModels(
  provider: string,
  settings: LLMSettings,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
  options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<ModelOption[]> {
  settings = { ...settings, [provider]: { ...settings[provider]!, headers: { ...settings[provider]?.headers } } }
  const key = `keundal:models:${provider}`
  let requests = latestRequests.get(storage)
  if (!requests) latestRequests.set(storage, (requests = new Map()))
  const request = Symbol()
  requests.set(provider, request)
  const isCurrent = () => requests.get(provider) === request
  let stale: { models: ModelOption[]; fetchedAt: number } | undefined
  const { scope, credentials } = await cacheScope(provider, settings)
  options.signal?.throwIfAborted()
  try {
    const cached = cacheSchema.safeParse(JSON.parse(storage.getItem(key) || 'null'))
    if (
      cached.success &&
      cached.data.scope === scope &&
      !options.force &&
      Date.now() >= cached.data.fetchedAt &&
      Date.now() - cached.data.fetchedAt < MODEL_CACHE_TTL
    )
      return cached.data.models
    if (
      cached.success &&
      cached.data.scope === scope &&
      Date.now() >= cached.data.fetchedAt &&
      Date.now() - cached.data.fetchedAt < MODEL_CACHE_MAX_AGE
    )
      stale = cached.data
    else if (isCurrent()) storage.removeItem(key)
  } catch {
    // Disabled/quota-limited storage must not prevent discovery.
  }
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
    : AbortSignal.timeout(15_000)
  try {
    const load = await modelLoaders[providerType(provider)]()
    options.signal?.throwIfAborted()
    const models = await load({ ...credentials, dangerouslyAllowBrowser: true }, { signal })
    options.signal?.throwIfAborted()
    const result = models.map((model) => ({
      value: `${provider}/${model.id}`,
      label:
        provider.includes('@') || settings[provider]?.name
          ? `${model.name} · ${settings[provider]!.name || provider}`
          : model.name,
      icon: providerIcon(provider),
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: model.capabilities
    }))
    try {
      if (isCurrent()) storage.setItem(key, JSON.stringify({ scope, fetchedAt: Date.now(), models: result }))
    } catch {
      // Discovery still works when localStorage is full or disabled.
    }
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    if (isCurrent() && stale && Date.now() >= stale.fetchedAt && Date.now() - stale.fetchedAt < MODEL_CACHE_MAX_AGE)
      return stale.models
    throw providerError(providerType(provider), error, credentials)
  }
}
