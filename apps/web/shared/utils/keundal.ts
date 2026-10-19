import type { UIMessage, UIMessageChunk } from 'ai'
import { EventType, LLM_SOURCE_EVENT, MessageAssembly, parseRunAgentInput, type AgentMessage, type LLMSource, type AGUIEvent } from '@keundal/core'
import simpleAgentPlugin from '@keundal/plugin-agent-simple'
import type { Context } from 'cordis'
import { z } from 'zod'
import { chartTool } from './tools/chart'
import { weatherTool } from './tools/weather'
import { resolveModel } from './models'

const randomUUID = () => globalThis.crypto.randomUUID()
const input = (messages: AgentMessage[], threadId: string = randomUUID(), runId: string = randomUUID(), state: unknown = {}) => ({ threadId, runId, state, context: [], tools: [], messages })

export function toMessages(messages: UIMessage[], model: string): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    // Persist the AG-UI conversation, including opaque reasoning and native search
    // blocks, in an invisible data part. Never send one provider's state to another.
    const saved = message.parts.find(part => part.type === 'data-keundal')
    if (message.role === 'assistant' && saved?.type === 'data-keundal') {
      const data = saved.data as { model: string, messages: AgentMessage[] }
      const parsed = parseRunAgentInput(input(data.messages)).messages
      return parsed.flatMap((item): AgentMessage[] => {
        if (resolveModel(data.model).value === resolveModel(model).value) return [item]
        if (item.role === 'reasoning') return []
        if (item.role !== 'assistant') return [item]
        return [{ ...item, metadata: undefined, toolCalls: item.toolCalls?.map(({ encryptedValue: _value, ...call }) => call) }]
      })
    }
    const result: AgentMessage[] = []
    if (message.role === 'user') {
      const content: Exclude<Extract<AgentMessage, { role: 'user' }>['content'], string> = []
      for (const part of message.parts) {
        if (part.type === 'text') content.push({ type: 'text', text: part.text })
        else if (part.type === 'file') {
          if (!part.mediaType.startsWith('image/')) throw new Error(`Keundal does not support this attachment: ${part.mediaType}`)
          const match = /^data:([^;]+);base64,(.*)$/s.exec(part.url)
          content.push({ type: 'image', source: match
            ? { type: 'data', mimeType: match[1]!, value: match[2]! }
            : { type: 'url', value: part.url, mimeType: part.mediaType } })
        }
      }
      return [{ id: message.id, role: 'user', content }]
    }
    for (const [index, part] of message.parts.entries()) {
      const id = `${message.id}-${index}`
      if (part.type === 'text') result.push({ id, role: message.role, content: part.text })
      else if (part.type === 'reasoning') {
        const metadata = part.providerMetadata?.keundal
        if (metadata && metadata.provider === model.split('/')[0] && typeof metadata.encryptedValue === 'string') {
          result.push({ id: typeof metadata.id === 'string' ? metadata.id : id, role: 'reasoning', content: part.text, encryptedValue: metadata.encryptedValue })
        }
      } else if (part.type.startsWith('tool-') && 'toolCallId' in part && 'input' in part && 'output' in part) {
        const metadata = part.callProviderMetadata?.keundal
        const encryptedValue = metadata && metadata.provider === model.split('/')[0] && typeof metadata.encryptedValue === 'string' ? metadata.encryptedValue : undefined
        result.push({ id, role: 'assistant', toolCalls: [{ id: part.toolCallId, type: 'function', function: { name: part.type.slice(5), arguments: JSON.stringify(part.input) }, ...(encryptedValue ? { encryptedValue } : {}) }] })
        result.push({ id: `${id}-result`, role: 'tool', toolCallId: part.toolCallId, content: JSON.stringify(part.output) })
      }
    }
    return result
  })
}

export async function createKeundalChat(context: Context, name: string, options: { webSearch?: boolean, reasoning?: boolean, maxOutputTokens?: number } = {}) {
  const config = resolveModel(name)
  const maxOutputTokens = options.maxOutputTokens ?? 4096
  const ctx = context.isolate('agent')
  const agent = ctx.plugin(simpleAgentPlugin, {
    model: config.value,
    maxOutputTokens,
    // The original template offers native search only on OpenAI and Anthropic.
    webSearch: !!options.webSearch && config.provider !== 'google',
    // Non-reasoning OpenAI models (e.g. GPT-4.1) do not accept a reasoning parameter.
    reasoning: options.reasoning === false && config.provider === 'openai' && !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.id) ? undefined : options.reasoning,
    maxToolRounds: 4,
    tools: Object.entries({ chart: chartTool, weather: weatherTool }).map(([name, tool]) => ({
      name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema),
      execute: async (args: Record<string, unknown>) => JSON.stringify(await tool.execute(tool.inputSchema.parse(args) as never))
    }))
  })
  const dispose = async () => {
    await agent.dispose()
  }
  try {
    await agent
  } catch (error) {
    await dispose()
    throw error
  }
  return {
    dispose,
    async title(message: UIMessage, signal?: AbortSignal) {
      let title = ''
      for await (const event of ctx.llm.stream({
        model: config.value,
        maxOutputTokens,
        input: input([
          { id: randomUUID(), role: 'system', content: 'Generate a chat title under 30 characters from the first user message. No quotes, punctuation, markdown, or commentary. Return only the title.' },
          { id: message.id, role: 'user', content: JSON.stringify(message) }
        ])
      }, { signal })) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) title += event.delta
      }
      return title.trim()
    },
    respond(request: {
      threadId: string
      messages: UIMessage[]
      instructions: string
      signal?: AbortSignal
      runId?: string
      state?: unknown
      /** A stored journal may be rendered without rerunning the agent or provider. */
      events?: AsyncIterable<AGUIEvent>
      titleGenerated?: boolean
      onFinish?: (message: UIMessage) => Promise<void>
    }): Response {
      const controller = new AbortController()
      const signal = request.signal ? AbortSignal.any([request.signal, controller.signal]) : controller.signal
      const runId = request.runId ?? randomUUID()
      const message: UIMessage = { id: runId, role: 'assistant', parts: [] }
      const assembly = new MessageAssembly()
      const texts = new Map<string, Extract<UIMessage['parts'][number], { type: 'text' | 'reasoning' }>>()
      const calls = new Map<string, { name: string, args: string, part: Extract<UIMessage['parts'][number], { type: `tool-${string}` }> }>()
      const sources = new Set<string>()
      let search: { type: 'tool-web_search', toolCallId: string, state: 'output-available', input: { query?: string }, output: LLMSource[], providerExecuted: true } | undefined
      const encoder = new TextEncoder()
      let cancelled = false
      return new Response(new ReadableStream<Uint8Array>({
        async start(output) {
          const write = (chunk: UIMessageChunk) => {
            if (!cancelled) output.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
          }
          let finished = false
          try {
            write({ type: 'start', messageId: message.id })
            if (request.titleGenerated) write({ type: 'data-chat-title', data: {}, transient: true })
            for await (const event of request.events ?? ctx.agent.run(input([
              { id: randomUUID(), role: 'system', content: request.instructions },
              ...toMessages(request.messages, name)
            ], request.threadId, runId, request.state), { signal })) {
              assembly.apply(event)
              switch (event.type) {
                case EventType.TEXT_MESSAGE_START:
                case EventType.REASONING_MESSAGE_START: {
                  const type = event.type === EventType.TEXT_MESSAGE_START ? 'text' : 'reasoning'
                  const part = { type, text: '' } as const
                  texts.set(event.messageId, part)
                  message.parts.push(part)
                  write({ type: `${type}-start`, id: event.messageId })
                  break
                }
                case EventType.TEXT_MESSAGE_CONTENT:
                case EventType.REASONING_MESSAGE_CONTENT: {
                  const type = event.type === EventType.TEXT_MESSAGE_CONTENT ? 'text' : 'reasoning'
                  texts.get(event.messageId)!.text += event.delta
                  write({ type: `${type}-delta`, id: event.messageId, delta: event.delta })
                  break
                }
                case EventType.TEXT_MESSAGE_END:
                case EventType.REASONING_MESSAGE_END: {
                  write({ type: event.type === EventType.TEXT_MESSAGE_END ? 'text-end' : 'reasoning-end', id: event.messageId })
                  const blocks = event.metadata?.['openai.outputItems'] ?? event.metadata?.['anthropic.contentBlocks']
                  if (Array.isArray(blocks)) {
                    for (const block of blocks) {
                      if (block.type !== 'web_search_call' && !(block.type === 'server_tool_use' && block.name === 'web_search')) continue
                      const query = block.type === 'web_search_call' ? block.action?.query ?? block.action?.queries?.join(' ') : block.input?.query
                      search = { type: 'tool-web_search', toolCallId: block.id, state: 'output-available', input: { query }, output: [], providerExecuted: true }
                      message.parts.push(search)
                      // Native search is display-only here; the provider already executed it.
                      write({ type: 'tool-input-available', toolCallId: search.toolCallId, toolName: 'web_search', input: search.input, providerExecuted: true })
                      write({ type: 'tool-output-available', toolCallId: search.toolCallId, output: [], providerExecuted: true })
                    }
                  }
                  break
                }
                case EventType.TOOL_CALL_START: {
                  const part = { type: `tool-${event.toolCallName}` as const, toolCallId: event.toolCallId, state: 'input-streaming' as const, input: undefined }
                  calls.set(event.toolCallId, { name: event.toolCallName, args: '', part })
                  message.parts.push(part)
                  write({ type: 'tool-input-start', toolCallId: event.toolCallId, toolName: event.toolCallName })
                  break
                }
                case EventType.TOOL_CALL_ARGS:
                  calls.get(event.toolCallId)!.args += event.delta
                  write({ type: 'tool-input-delta', toolCallId: event.toolCallId, inputTextDelta: event.delta })
                  break
                case EventType.TOOL_CALL_END: {
                  const call = calls.get(event.toolCallId)!
                  const args = JSON.parse(call.args)
                  Object.assign(call.part, { state: 'input-available', input: args })
                  write({ type: 'tool-input-available', toolCallId: event.toolCallId, toolName: call.name, input: args })
                  break
                }
                case EventType.TOOL_CALL_RESULT: {
                  const result = JSON.parse(event.content as string)
                  Object.assign(calls.get(event.toolCallId)!.part, { state: 'output-available', output: result })
                  write({ type: 'tool-output-available', toolCallId: event.toolCallId, output: result })
                  break
                }
                case EventType.CUSTOM:
                  if (event.name === LLM_SOURCE_EVENT) {
                    const source = event.value as LLMSource
                    if (!sources.has(source.id)) {
                      sources.add(source.id)
                      const part = { type: 'source-url' as const, sourceId: source.id, url: source.url, title: source.title }
                      message.parts.push(part)
                      write(part)
                      if (search) {
                        search.output.push(source)
                        write({ type: 'tool-output-available', toolCallId: search.toolCallId, output: search.output, providerExecuted: true })
                      }
                    }
                  }
                  break
                case EventType.RUN_ERROR:
                  throw new Error(event.message)
                case EventType.RUN_FINISHED:
                  finished = true
                  break
              }
            }
            if (!finished) throw new Error('Keundal generation did not finish')
          } catch (error) {
            write(signal.aborted ? { type: 'abort' } : { type: 'error', errorText: error instanceof Error ? error.message : String(error) })
          } finally {
            // Only replay completed calls and signed reasoning. A stopped stream
            // must not poison the next turn with partial JSON or unsigned thinking.
            const results = new Set(assembly.messages.flatMap(item => item.role === 'tool' ? [item.toolCallId] : []))
            const replay = assembly.messages
              .filter(item => item.role !== 'reasoning' || !!item.encryptedValue)
              .map(item => item.role === 'assistant'
                ? { ...item, toolCalls: item.toolCalls?.filter(call => results.has(call.id)) }
                : item)
            const data = { type: 'data-keundal' as const, data: { model: name, messages: replay } }
            message.parts.push(data)
            write(data)
            try {
              await request.onFinish?.(message)
              if (finished) write({ type: 'finish', finishReason: 'stop' })
            } catch {
              write({ type: 'error', errorText: 'Failed to save chat response' })
            }
            if (!cancelled) {
              output.enqueue(encoder.encode('data: [DONE]\n\n'))
              output.close()
            }
            await dispose()
          }
        },
        cancel(reason) {
          cancelled = true
          controller.abort(reason)
        }
      }), { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-vercel-ai-ui-message-stream': 'v1' } })
    }
  }
}
