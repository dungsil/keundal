import { STREAM_LIMITS, StreamBudget } from '@keundal/llm'

/** Shared HTTP transport limit, including desktop sidecar connections. */
export class RemoteResponseLimitError extends Error {}

/** Retained across reconnects and the final cancellation journal drain. */
export class RemoteStreamBudget {
  private bytes = 0
  private frames = 0
  private readonly events = new StreamBudget()

  read(bytes: number) {
    this.bytes += bytes
    if (this.bytes > STREAM_LIMITS.bytes) throw new RemoteResponseLimitError('Remote response byte limit exceeded')
  }

  frame() {
    if (++this.frames > STREAM_LIMITS.events) throw new RemoteResponseLimitError('Remote response frame limit exceeded')
  }

  event(value: unknown) {
    try {
      this.events.accept(value)
    } catch (error) {
      throw new RemoteResponseLimitError(error instanceof Error ? error.message : String(error))
    }
  }
}

/** Count decompressed bytes before JSON, text, or SSE consumers retain them. */
export async function boundRemoteResponse(response: Response, signal?: AbortSignal): Promise<Response> {
  if (!response.body) return response
  const limit = response.ok ? STREAM_LIMITS.bytes : 16 * 1024
  const declared = response.headers.get('content-length')
  if (declared && /^\d+$/.test(declared) && Number(declared) > limit) {
    void response.body.cancel().catch(() => {})
    throw new RemoteResponseLimitError('Remote response byte limit exceeded')
  }
  const reader = response.body.getReader()
  let bytes = 0
  let closed = false
  const release = () => {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
  const cancel = (reason?: unknown) => {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', abort)
    void reader
      .cancel(reason)
      .catch(() => {})
      .finally(release)
  }
  let output: ReadableStreamDefaultController<Uint8Array>
  const abort = () => {
    cancel(signal?.reason)
    output.error(signal?.reason)
  }
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller
        signal?.addEventListener('abort', abort, { once: true })
        if (signal?.aborted) abort()
      },
      async pull(controller) {
        try {
          const next = await reader.read()
          if (closed) return
          if (next.done) {
            closed = true
            release()
            controller.close()
            return
          }
          bytes += next.value.byteLength
          if (bytes > limit) throw new RemoteResponseLimitError('Remote response byte limit exceeded')
          controller.enqueue(next.value)
        } catch (error) {
          if (closed) return
          cancel(error)
          controller.error(error)
        }
      },
      cancel
    },
    { highWaterMark: 0 }
  )
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
