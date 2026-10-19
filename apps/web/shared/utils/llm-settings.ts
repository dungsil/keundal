import { z } from 'zod'

export const LLM_PROVIDERS = [
  { id: 'anthropic', label: 'Anthropic', baseURL: 'https://api.anthropic.com' },
  { id: 'google', label: 'Google Gemini', baseURL: 'https://generativelanguage.googleapis.com' },
  { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1' }
] as const

export type LLMProvider = typeof LLM_PROVIDERS[number]['id']

const headersSchema = z.record(
  z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, 'Invalid request header name'),
  z.string().max(4096).regex(/^[\t\x20-\x7e]*$/, 'Header values must use ASCII without line breaks')
).superRefine((headers, ctx) => {
  const names = Object.keys(headers).map(name => name.toLowerCase())
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'Duplicate request header names' })
}).transform(headers => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value])))

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
  }, 'Use an HTTPS API URL without credentials, query or fragment (HTTP is allowed for localhost)'),
  headers: headersSchema.optional()
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
  return { apiKey: parsed.data.apiKey, baseURL: parsed.data.baseURL || undefined, headers: parsed.data.headers }
}

/** Only display a bounded 400 diagnostic, never the response object, headers or cause. */
export function providerError(provider: LLMProvider, error: unknown, credentials: { apiKey: string, baseURL?: string, headers?: Record<string, string> }): Error {
  const failure = z.object({ status: z.number().optional(), message: z.string().optional(), error: z.unknown().optional() }).safeParse(error)
  const status = failure.success ? failure.data.status : undefined
  function message(value: unknown, depth = 0): string {
    if (depth > 6) return ''
    if (typeof value === 'string') {
      try {
        return message(JSON.parse(value), depth + 1)
      } catch {
        return value
      }
    }
    if (value && typeof value === 'object') {
      if ('error' in value) return message(value.error, depth + 1)
      if ('message' in value) return message(value.message, depth + 1)
    }
    return ''
  }
  let detail = status === 400 && failure.success ? message(failure.data.error ?? failure.data.message) : ''
  const secrets = [credentials.apiKey, credentials.baseURL, ...Object.values(credentials.headers ?? {}).flatMap(value => [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')])].filter((value): value is string => !!value?.trim())
  for (const secret of secrets.sort((a, b) => b.length - a.length)) {
    const variants = [secret, secret.trim(), JSON.stringify(secret).slice(1, -1)]
    try {
      variants.push(encodeURIComponent(secret))
    } catch {
      // Malformed Unicode in a key must not prevent redaction of its original value.
    }
    for (const value of variants) detail = detail.split(value).join('[redacted]')
  }
  // eslint-disable-next-line no-control-regex -- Remove control characters from untrusted provider diagnostics.
  detail = detail.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 1000)
  return new Error(`${provider} request failed${status ? ` (HTTP ${status})` : ''}. ${detail || 'Check your API key, API URL and the endpoint\'s browser CORS permissions.'}`)
}
