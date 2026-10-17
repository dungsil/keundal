import { LLMService, parseAGUIEvent, type LLMEvent, type LLMModel, type LLMRequest, type ExecutionOptions } from '@keundal/core'
import type { Context } from 'cordis'

/** Standard llm service over HTTP; browser stores/agents never receive provider credentials. */
export function remoteLLMPlugin(ctx: Context, config: { fetch: typeof globalThis.fetch }) {
  class RemoteLLM extends LLMService {
    private async request(operation: string, body: unknown, options?: ExecutionOptions) {
      const response = await config.fetch('/api/llm', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operation, ...body as object }), signal: options?.signal
      })
      if (!response.ok) {
        const error = await response.json() as { message?: string, statusMessage?: string }
        throw new Error(error.message || error.statusMessage || `LLM request failed (${response.status})`)
      }
      return response
    }

    async getModel(model: string, options?: ExecutionOptions): Promise<LLMModel> {
      return (await this.request('model', { model }, options)).json()
    }

    async countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number> {
      return (await (await this.request('count', request, options)).json() as { tokens: number }).tokens
    }

    async* stream(request: LLMRequest, options?: ExecutionOptions): AsyncIterable<LLMEvent> {
      const controller = new AbortController()
      const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
      const response = await this.request('stream', request, { signal })
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
      let buffered = ''
      let completed = false
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) {
            if (buffered.trim() || !completed) throw new Error('Incomplete LLM stream')
            break
          }
          buffered += next.value
          let newline: number
          while ((newline = buffered.indexOf('\n')) !== -1) {
            const line = buffered.slice(0, newline)
            buffered = buffered.slice(newline + 1)
            if (!line.trim()) continue
            const value = JSON.parse(line)
            if (value.error) throw new Error(value.error)
            if (value.done === true) {
              completed = true
              continue
            }
            const event = parseAGUIEvent(value)
            if (event.type === 'RUN_STARTED' || event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') throw new Error('LLM endpoint returned a generation event')
            yield event
          }
        }
      } finally {
        controller.abort()
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
    }
  }
  new RemoteLLM(ctx)
}
