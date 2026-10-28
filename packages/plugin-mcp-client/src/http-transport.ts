import { parseMcpHttpUrl, type McpClientConfig, type McpConnectOptions } from '@keundal/mcp'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'

import { DEFAULT_MAX_RESULT_BYTES } from './result-budget.js'

export const transportByteLimit = (maxResultBytes = DEFAULT_MAX_RESULT_BYTES) =>
  2 * Math.max(DEFAULT_MAX_RESULT_BYTES, maxResultBytes)

/** Only successful request streams reach the SDK's SSE parser; other bodies are read as text. */
function streamsEvents(init: globalThis.RequestInit | undefined): boolean {
  if (init?.method === 'GET') return true
  if (init?.method !== 'POST' || typeof init.body !== 'string') return false
  // This is the SDK's own outgoing envelope, never the peer's response.
  const body = JSON.parse(init.body)
  return (Array.isArray(body) ? body : [body]).some(
    (message) => message && typeof message === 'object' && 'method' in message && message.id !== undefined
  )
}

export function createHttpTransport(
  config: Extract<McpClientConfig, { transport: 'streamable-http' }>,
  options: McpConnectOptions = {}
) {
  const authentication = options.authentication
  const authenticationSignal = authentication?.signal
  authenticationSignal?.throwIfAborted()
  if (authentication) {
    // OAuth never inherits the plaintext HTTP opt-in or a conflicting static bearer token.
    if (parseMcpHttpUrl(config.url).href !== new globalThis.URL(authentication.serverUrl).href)
      throw new Error('MCP credentials belong to a different server')
    if (new globalThis.Headers(config.headers).has('authorization'))
      throw new Error('MCP OAuth cannot be combined with an Authorization header')
  }
  const limit = transportByteLimit(config.maxResultBytes)
  let failure: Error | undefined
  const lifetime = new globalThis.AbortController()
  const rejectedTokens = new WeakMap<globalThis.Response, string>()
  const transport = new StreamableHTTPClientTransport(new globalThis.URL(config.url), {
    ...(authentication
      ? {
          authProvider: {
            token: () => authentication.token({ signal: lifetime.signal }),
            onUnauthorized: ({ response }) =>
              authentication.onUnauthorized({
                signal: lifetime.signal,
                rejectedToken: rejectedTokens.get(response)
              })
          }
        }
      : {}),
    requestInit: { headers: config.headers, redirect: 'error' },
    fetch: async (url, init) => {
      if (failure) throw failure
      authenticationSignal?.throwIfAborted()
      const response = await globalThis.fetch(url, init)
      const rejected =
        response.status === 401 ? new globalThis.Headers(init?.headers).get('authorization')?.slice(7) : undefined
      if (!response.body) {
        if (rejected) rejectedTokens.set(response, rejected)
        return response
      }
      const events =
        response.ok &&
        response.status !== 202 &&
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() === 'text/event-stream' &&
        streamsEvents(init)
      const reader = response.body.getReader()
      const overflow = () => {
        const error = new Error('MCP transport response exceeds the byte limit')
        failure = error
        void reader.cancel(error).catch(() => {})
        transport.onerror?.(error)
        void transport.close().catch(() => {})
        return error
      }
      const length = response.headers.get('content-length')
      if (!events && length !== null && Number(length) > limit) throw overflow()
      let bytes = 0
      let lineBytes = 0
      let carriageReturn = false
      const body = new globalThis.ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            try {
              const { value, done } = await reader.read()
              if (done) {
                controller.close()
                return
              }
              if (events) {
                // Count framing, comments and incomplete lines before the UTF-8/SSE parsers buffer them.
                for (const byte of value) {
                  if (++bytes > limit) throw overflow()
                  if (byte === 10 && carriageReturn) {
                    carriageReturn = false
                    continue
                  }
                  carriageReturn = byte === 13
                  if (byte === 10 || byte === 13) {
                    if (lineBytes === 0) bytes = 0
                    lineBytes = 0
                  } else lineBytes++
                }
              } else {
                bytes += value.byteLength
                if (bytes > limit) throw overflow()
              }
              controller.enqueue(value)
            } catch (error) {
              controller.error(error)
            }
          },
          cancel(reason) {
            return reader.cancel(reason)
          }
        },
        { highWaterMark: 0 }
      )
      const bounded = new globalThis.Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      })
      if (rejected) rejectedTokens.set(bounded, rejected)
      return bounded
    }
  })
  const close = transport.close.bind(transport)
  transport.close = async () => {
    lifetime.abort()
    authenticationSignal?.removeEventListener('abort', authenticationChanged)
    await close()
  }
  const authenticationChanged = () => {
    transport.onerror?.(new Error('MCP authentication changed; reconnect after login'))
    void transport.close().catch(() => {})
  }
  authenticationSignal?.addEventListener('abort', authenticationChanged, { once: true })
  return transport
}
