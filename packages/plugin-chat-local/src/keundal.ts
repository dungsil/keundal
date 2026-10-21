import type { AgentConfig } from '@keundal/agent-contract'
import { ChatMessageAssembly, type ChatMessage } from '@keundal/chat/chat-message'
import { ChatMessagePublisher } from '@keundal/chat/chat-message-publisher'
import { toMessages } from '@keundal/chat/messages'
import { EventType, type AGUIEvent, type AgentMessage } from '@keundal/core'
import type { Fiber } from 'cordis'
import type { Context } from 'cordis'
export { toMessages } from '@keundal/chat/messages'
import { resolveModel } from '@keundal/chat/models'

const randomUUID = () => globalThis.crypto.randomUUID()
const input = (
  messages: AgentMessage[],
  threadId: string = randomUUID(),
  runId: string = randomUUID(),
  state: unknown = {}
) => ({ threadId, runId, state, context: [], tools: [], messages })

export async function createKeundalChat(
  context: Context,
  name: string,
  options: { webSearch?: boolean; reasoning?: boolean; maxOutputTokens?: number },
  mountAgent: (ctx: Context, config: AgentConfig) => Promise<Fiber>
) {
  const config = resolveModel(name)
  const maxOutputTokens = options.maxOutputTokens ?? 4096
  const ctx = context.isolate('agent')
  const agent = ctx.plugin(async (child: Context) => {
    await mountAgent(child, {
      model: config.value,
      maxOutputTokens,
      webSearch: !!options.webSearch && config.provider !== 'google',
      reasoning:
        options.reasoning === false && config.provider === 'openai' && !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.id)
          ? undefined
          : options.reasoning,
      maxToolRounds: 4,
      skills: !!context.skills
    })
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
      for await (const event of ctx.llm.stream(
        {
          model: selected,
          maxOutputTokens: Math.min(4096, limits.maxOutputTokens, limits.contextWindow - 1),
          input: input([
            {
              id: randomUUID(),
              role: 'system',
              content:
                'Generate a chat title under 30 characters from the first user message. No quotes, punctuation, markdown, or commentary. Return only the title.'
            },
            { id: message.id, role: 'user', content: JSON.stringify(message) }
          ])
        },
        { signal }
      )) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) title += event.delta
      }
      return title.trim()
    },
    async *respond(request: {
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
        for await (const event of request.events ??
          ctx.agent.run(
            input(
              [
                { id: 'keundal:web-instructions', role: 'system', content: request.instructions },
                ...toMessages(request.messages, name)
              ],
              request.threadId,
              runId,
              request.state
            ),
            { signal: request.signal }
          )) {
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
