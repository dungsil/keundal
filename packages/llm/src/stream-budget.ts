/** Local limits apply independently of provider token accounting. */
export const STREAM_LIMITS = {
  bytes: 32 * 1024 * 1024,
  eventBytes: 8 * 1024 * 1024,
  events: 16_384,
  nodes: 262_144,
  depth: 64
} as const

/** Checks JSON-shaped payloads before copying, concatenating or serializing them. */
export class StreamBudget {
  private bytes = 0
  private events = 0

  accept(value: unknown): void {
    if (this.events >= STREAM_LIMITS.events) throw new Error('stream event limit exceeded')
    let bytes = 0
    let nodes = 0
    const ancestors = new Set<object>()
    const add = (size: number) => {
      bytes += size
      if (bytes > STREAM_LIMITS.eventBytes || this.bytes + bytes > STREAM_LIMITS.bytes) {
        throw new Error('stream byte limit exceeded')
      }
    }
    const string = (text: string) => {
      // Reject by a cheap lower bound before scanning; never encode or stringify
      // the untrusted value just to measure it.
      if (text.length > STREAM_LIMITS.eventBytes || this.bytes + text.length > STREAM_LIMITS.bytes) {
        throw new Error('stream byte limit exceeded')
      }
      add(2)
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i)
        if (code < 32) add(6)
        else if (code === 34 || code === 92) add(2)
        else if (code < 128) add(1)
        else if (code < 2048) add(2)
        else if (
          code >= 0xd800 &&
          code <= 0xdbff &&
          text.charCodeAt(i + 1) >= 0xdc00 &&
          text.charCodeAt(i + 1) <= 0xdfff
        ) {
          add(4)
          i++
        } else add(code >= 0xd800 && code <= 0xdfff ? 6 : 3)
      }
    }
    const visit = (item: unknown, depth: number): void => {
      if (++nodes > STREAM_LIMITS.nodes || depth > STREAM_LIMITS.depth) {
        throw new Error('stream structure limit exceeded')
      }
      if (typeof item === 'string') string(item)
      else if (typeof item === 'object' && item !== null) {
        if (Array.isArray(item) && item.length > STREAM_LIMITS.nodes) throw new Error('stream structure limit exceeded')
        if ('toJSON' in item && typeof item.toJSON === 'function')
          throw new Error('custom stream serialization is not supported')
        if (ancestors.has(item)) throw new Error('cyclic stream payload')
        ancestors.add(item)
        add(2)
        if (Array.isArray(item)) {
          for (let i = 0; i < item.length; i++) {
            add(1)
            visit(item[i], depth + 1)
          }
        } else {
          for (const key in item) {
            if (!Object.hasOwn(item, key)) continue
            string(key)
            add(2)
            visit((item as Record<string, unknown>)[key], depth + 1)
          }
        }
        ancestors.delete(item)
      } else add(24)
    }
    visit(value, 0)
    this.bytes += bytes
    this.events++
  }
}

/** Bound the response before an SDK accumulates frames or parses JSON. */
export const fetchWithStreamLimit: typeof globalThis.fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init)
  if (!response.body) return response
  const reader = response.body.getReader()
  let bytes = 0
  const body = new globalThis.ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          reader.releaseLock()
          return
        }
        bytes += next.value.byteLength
        if (bytes > STREAM_LIMITS.bytes) throw new Error('provider response byte limit exceeded')
        controller.enqueue(next.value)
      } catch (error) {
        await reader.cancel(error).catch(() => {})
        controller.error(error)
      }
    },
    async cancel(reason) {
      await reader.cancel(reason)
    }
  })
  const bounded = new globalThis.Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
  Object.defineProperties(bounded, {
    url: { value: response.url },
    redirected: { value: response.redirected },
    type: { value: response.type }
  })
  return bounded
}
