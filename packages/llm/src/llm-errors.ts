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
