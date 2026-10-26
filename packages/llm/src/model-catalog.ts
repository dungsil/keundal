/** Limits apply to one complete model discovery, including discarded entries. */
export const MODEL_CATALOG_LIMITS = {
  pageBytes: 1024 * 1024,
  bytes: 8 * 1024 * 1024,
  pages: 32,
  entries: 4096,
  fieldLength: 1024,
  cursorLength: 2048,
  nodes: 262_144,
  depth: 16
} as const

/** Bound transport consumption before JSON decoding and catalog accumulation. */
export class ModelCatalogBudget {
  private bytes = 0
  private pages = 0
  private entries = 0
  private nodes = 0

  beginPage(): void {
    if (++this.pages > MODEL_CATALOG_LIMITS.pages) throw new Error('model catalog page limit exceeded')
  }

  acceptEntries(count: number): void {
    this.entries += count
    if (this.entries > MODEL_CATALOG_LIMITS.entries) throw new Error('model catalog entry limit exceeded')
  }

  async readJSON(response: globalThis.Response): Promise<unknown> {
    if (!response.body) throw new Error('Missing model catalog response body')
    const reader = response.body.getReader()
    const decoder = new globalThis.TextDecoder()
    let pageBytes = 0
    let text = ''
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        pageBytes += next.value.byteLength
        this.bytes += next.value.byteLength
        if (pageBytes > MODEL_CATALOG_LIMITS.pageBytes || this.bytes > MODEL_CATALOG_LIMITS.bytes) {
          throw new Error('model catalog byte limit exceeded')
        }
        text += decoder.decode(next.value, { stream: true })
      }
      text += decoder.decode()
    } catch (error) {
      await reader.cancel(error).catch(() => {})
      throw error
    } finally {
      reader.releaseLock()
    }
    const value: unknown = JSON.parse(text)
    const visit = (item: unknown, depth: number): void => {
      if (++this.nodes > MODEL_CATALOG_LIMITS.nodes || depth > MODEL_CATALOG_LIMITS.depth) {
        throw new Error('model catalog structure limit exceeded')
      }
      if (item !== null && typeof item === 'object') {
        for (const key in item) {
          if (Object.hasOwn(item, key)) visit((item as Record<string, unknown>)[key], depth + 1)
        }
      }
    }
    visit(value, 0)
    return value
  }
}
