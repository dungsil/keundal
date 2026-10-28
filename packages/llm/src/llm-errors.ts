/** 공급자가 명시한 컨텍스트 초과만 판별하며 일반 요청·출력 한도 오류는 제외합니다. */
export function isContextOverflow(error: unknown): boolean {
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return false
    seen.add(value)
    const item = value as Record<string, unknown>
    if (item.code === 'context_length_exceeded' || item.code === 'context_window_exceeded') return true
    const status = item.status ?? item.code
    if (
      (status === 400 || status === 413) &&
      typeof item.message === 'string' &&
      /prompt is too long|input (?:token count|tokens?).*exceed|exceed.*context (?:window|length)|maximum context length/i.test(
        item.message
      )
    )
      return true
    return ['cause', 'error', 'response'].some((key) => visit(item[key], depth + 1))
  }
  return visit(error, 0)
}

/** Only transport failures and explicitly transient provider statuses are retryable. */
export function isTransientLLMError(error: unknown): boolean {
  if (isContextOverflow(error)) return false
  const seen = new Set<unknown>()
  const visit = (value: unknown, depth: number): boolean => {
    if (!value || typeof value !== 'object' || depth > 6 || seen.has(value)) return false
    seen.add(value)
    const item = value as Record<string, unknown>
    const constructorName = value.constructor?.name
    if (item.name === 'AbortError' || constructorName === 'APIUserAbortError') return false
    const status = item.status ?? item.statusCode
    if (typeof status === 'number') return [429, 500, 502, 503, 504, 529].includes(status)
    if (item.code === 'llm_transient_error') return true
    if (
      [item.name, constructorName].some((name) => name === 'APIConnectionError' || name === 'APIConnectionTimeoutError')
    )
      return true
    if (
      [
        'ECONNRESET',
        'ETIMEDOUT',
        'EAI_AGAIN',
        'ECONNREFUSED',
        'ENETUNREACH',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_SOCKET'
      ].includes(String(item.code))
    )
      return true
    if (
      item.name === 'TypeError' &&
      /^(fetch failed|failed to fetch|networkerror when attempting to fetch resource\.?|load failed)$/i.test(
        String(item.message)
      )
    )
      return true
    return ['cause', 'error'].some((key) => visit(item[key], depth + 1))
  }
  return visit(error, 0)
}

/** Extract only a numeric cooldown; callers may discard all provider headers and diagnostics. */
export function llmRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined
  const item = error as { retryAfterMs?: unknown; headers?: { get?: (name: string) => string | null } }
  if (typeof item.retryAfterMs === 'number' && Number.isFinite(item.retryAfterMs) && item.retryAfterMs >= 0)
    return item.retryAfterMs
  const value = typeof item.headers?.get === 'function' ? item.headers.get('retry-after') : undefined
  if (!value?.trim()) return undefined
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined
}
