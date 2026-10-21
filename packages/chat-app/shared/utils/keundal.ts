import { ChatMessagePublisher } from './chat-message-publisher'
import { EventType, parseRunAgentInput, prepareReplayMessages, type AgentMessage, type AGUIEvent } from '@keundal/core'
import agentPlugin, { type ExecutableTool } from '@keundal/agent'
import type { Context } from 'cordis'
import { ChatMessageAssembly, type ChatMessage } from './chat-message'
import { createChatTools } from './tools/agent'
import { resolveModel } from './models'

const randomUUID = () => globalThis.crypto.randomUUID()
const input = (messages: AgentMessage[], threadId: string = randomUUID(), runId: string = randomUUID(), state: unknown = {}) => ({ threadId, runId, state, context: [], tools: [], messages })

export function toMessages(messages: ChatMessage[], model: string): AgentMessage[] {
  return messages.flatMap((message): AgentMessage[] => {
    // Keep existing IndexedDB conversations readable, including opaque reasoning
    // and native search blocks. Never send one model's state to another.
    const saved = message.parts.find(part => part.type === 'data-keundal')
    if (message.role === 'assistant' && saved?.type === 'data-keundal') {
      const data = saved.data
      const parsed = parseRunAgentInput(input(data.messages)).messages
      return prepareReplayMessages(parsed, resolveModel(data.model).value, resolveModel(model).value)
    }
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
    return message.parts.flatMap((part, index): AgentMessage[] => part.type === 'text'
      ? [{ id: `${message.id}-${index}`, role: message.role, content: part.text }]
      : [])
  })
}

export async function createKeundalChat(context: Context, name: string, options: { webSearch?: boolean, reasoning?: boolean, maxOutputTokens?: number, tools?: (options: { signal?: AbortSignal }) => Promise<ExecutableTool[]> } = {}) {
  const config = resolveModel(name)
  const maxOutputTokens = options.maxOutputTokens ?? 4096
  const ctx = context.isolate('agent')
  const agent = ctx.plugin(agentPlugin, {
    model: config.value,
    maxOutputTokens,
    webSearch: !!options.webSearch && config.provider !== 'google',
    reasoning: options.reasoning === false && config.provider === 'openai' && !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.id) ? undefined : options.reasoning,
    maxToolRounds: 4,
    skills: !!context.skills,
    tools: async execution => [...createChatTools(), ...await (options.tools?.(execution) ?? [])]
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
    async title(message: ChatMessage, signal?: AbortSignal, titleModel = config.value) {
      const selected = resolveModel(titleModel).value
      const limits = await ctx.llm.getModel(selected, { signal })
      let title = ''
      for await (const event of ctx.llm.stream({
        model: selected,
        maxOutputTokens: Math.min(4096, limits.maxOutputTokens, limits.contextWindow - 1),
        input: input([
          { id: randomUUID(), role: 'system', content: 'Generate a chat title under 30 characters from the first user message. No quotes, punctuation, markdown, or commentary. Return only the title.' },
          { id: message.id, role: 'user', content: JSON.stringify(message) }
        ])
      }, { signal })) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          if (title.length + event.delta.length > 1024) throw new Error('Generated title exceeds input limit')
          title += event.delta
        }
      }
      title = title.trim()
      if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
      return title
    },
    async* respond(request: {
      threadId: string
      messages: ChatMessage[]
      instructions: string
      signal?: AbortSignal
      runId?: string
      state?: unknown
      /** A stored journal may be rendered without rerunning the agent or provider. */
      events?: AsyncIterable<AGUIEvent>
      onMessage?: (message: ChatMessage) => void
      onFinish?: (message: ChatMessage) => Promise<void>
    }): AsyncGenerator<AGUIEvent> {
      const runId = request.runId ?? randomUUID()
      const projection = new ChatMessageAssembly(runId)
      const publisher = new ChatMessagePublisher(request.onMessage)
      let finished: Extract<AGUIEvent, { type: 'RUN_FINISHED' }> | undefined
      let failed = false
      try {
        for await (const event of request.events ?? ctx.agent.run(input([
          { id: 'keundal:web-instructions', role: 'system', content: request.instructions },
          ...toMessages(request.messages, name)
        ], request.threadId, runId, request.state), { signal: request.signal })) {
          projection.apply(event)
          publisher.update(event, projection.message)
          if (event.type === EventType.RUN_FINISHED) finished = event
          else {
            if (event.type === EventType.RUN_ERROR) failed = true
            yield event
          }
        }
        if (!finished && !failed && !request.events) throw new Error('Keundal generation did not finish')
      } catch (error) {
        yield { type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : String(error) }
      } finally {
        projection.finish(name)
        await request.onFinish?.(projection.message)
        publisher.finish(projection.message)
      }
      // The UI sees success only after the display message is durably saved too.
      if (finished) yield finished
    }
  }
}
