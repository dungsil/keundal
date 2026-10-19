import { EventType, LLM_SOURCE_EVENT, MessageAssembly, prepareReplayMessages, type AGUIEvent, type AgentMessage, type LLMSource } from '@keundal/core'

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'
export type TextPart = { type: 'text', text: string, state?: 'streaming' | 'done' }
  | { type: 'reasoning', text: string, state?: 'streaming' | 'done' }
export type FilePart = { type: 'file', mediaType: string, filename?: string, url: string }
export type ToolInvocation<T extends { input: unknown, output: unknown } = { input: unknown, output: unknown }> = {
  toolCallId: string
} & (
  | { state: 'input-streaming', input?: Partial<T['input']>, output?: never }
  | { state: 'input-available', input: T['input'], output?: never }
  | { state: 'output-available', input: T['input'], output: T['output'] }
  | { state: 'output-error', input?: T['input'], output?: never, errorText: string }
)
export type ToolPart = ToolInvocation & { type: `tool-${string}`, providerExecuted?: boolean }
export type ChatPart = TextPart | FilePart | ToolPart
  | { type: 'source-url', sourceId: string, url: string, title?: string }
  | { type: 'data-keundal', data: { model: string, messages: AgentMessage[] } }

/** Presentation state owned by the web app, not a provider or transport protocol. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: ChatPart[]
}

/** Projects native AG-UI events into the existing chat components and durable replay. */
export class ChatMessageAssembly {
  readonly message: ChatMessage
  private readonly assembly = new MessageAssembly()
  private readonly texts = new Map<string, TextPart>()
  private readonly calls = new Map<string, { args: string, part: ToolPart }>()
  private readonly sources = new Set<string>()
  private search?: ToolPart & { state: 'output-available', output: LLMSource[] }

  constructor(id: string) {
    this.message = { id, role: 'assistant', parts: [] }
  }

  apply(event: AGUIEvent) {
    this.assembly.apply(event)
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
      case EventType.REASONING_MESSAGE_START: {
        const part: TextPart = { type: event.type === EventType.TEXT_MESSAGE_START ? 'text' : 'reasoning', text: '', state: 'streaming' }
        this.texts.set(event.messageId, part)
        this.message.parts.push(part)
        break
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CONTENT:
        this.texts.get(event.messageId)!.text += event.delta
        break
      case EventType.TEXT_MESSAGE_END:
      case EventType.REASONING_MESSAGE_END: {
        delete this.texts.get(event.messageId)!.state
        const blocks = event.metadata?.['openai.outputItems'] ?? event.metadata?.['anthropic.contentBlocks']
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type !== 'web_search_call' && !(block.type === 'server_tool_use' && block.name === 'web_search')) continue
            const query = block.type === 'web_search_call' ? block.action?.query ?? block.action?.queries?.join(' ') : block.input?.query
            this.search = { type: 'tool-web_search', toolCallId: block.id, state: 'output-available', input: { query }, output: [], providerExecuted: true }
            this.message.parts.push(this.search)
          }
        }
        break
      }
      case EventType.TOOL_CALL_START: {
        const part: ToolPart = { type: `tool-${event.toolCallName}`, toolCallId: event.toolCallId, state: 'input-streaming' }
        this.calls.set(event.toolCallId, { args: '', part })
        this.message.parts.push(part)
        break
      }
      case EventType.TOOL_CALL_ARGS:
        this.calls.get(event.toolCallId)!.args += event.delta
        break
      case EventType.TOOL_CALL_END: {
        const call = this.calls.get(event.toolCallId)!
        Object.assign(call.part, { state: 'input-available', input: JSON.parse(call.args) })
        break
      }
      case EventType.TOOL_CALL_RESULT:
        Object.assign(this.calls.get(event.toolCallId)!.part, { state: 'output-available', output: JSON.parse(event.content as string) })
        break
      case EventType.CUSTOM:
        if (event.name === LLM_SOURCE_EVENT) {
          const source = event.value as LLMSource
          if (!this.sources.has(source.id)) {
            this.sources.add(source.id)
            this.message.parts.push({ type: 'source-url', sourceId: source.id, url: source.url, title: source.title })
            this.search?.output.push(source)
          }
        }
        break
    }
  }

  finish(model: string) {
    // Interrupted text must not remain animated. Only complete calls and signed
    // reasoning can be replayed to a provider on the next turn.
    for (const part of this.texts.values()) delete part.state
    for (const { part } of this.calls.values()) {
      if (part.state !== 'output-available') Object.assign(part, { state: 'output-error', errorText: 'Tool execution interrupted' })
    }
    const messages = prepareReplayMessages(this.assembly.messages, model, model)
    this.message.parts.push({ type: 'data-keundal', data: { model, messages } })
  }
}
