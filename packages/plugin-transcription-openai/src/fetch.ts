const CREDENTIAL_RESPONSE_BYTES = 64 * 1024

/** Bound decoded HTTP bytes before the SDK buffers success or error JSON. */
export const fetchCredentials: typeof globalThis.fetch = async (input, init) => {
  const response = await globalThis.fetch(input, init)
  const overflow = () => new Error('Transcription credential response byte limit exceeded')
  const length = response.headers.get('content-length')
  if (length !== null && Number(length) > CREDENTIAL_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw overflow()
  }
  if (!response.body) return response
  const reader = response.body.getReader()
  let bytes = 0
  const body = new globalThis.ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          reader.releaseLock()
          controller.close()
          return
        }
        bytes += next.value.byteLength
        if (bytes > CREDENTIAL_RESPONSE_BYTES) throw overflow()
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
