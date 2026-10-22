import type { AgentConfig } from '@keundal/agent-loop'
import '@keundal/agent'
import { ChatMessageAssembly, type ChatMessage } from '@keundal/chat/chat-message'
import { ChatMessagePublisher } from '@keundal/chat/chat-message-publisher'
import { validateChatTitle } from '@keundal/chat/chat-store'
import { toMessages } from '@keundal/chat/messages'
import { type Reasoning, EventType, type AGUIEvent, type AgentMessage, type SteerQueue } from '@keundal/core'
import type { Fiber } from 'cordis'
import type { Context } from 'cordis'
export { toMessages } from '@keundal/chat/messages'
import { resolveModel } from '@keundal/chat/models'

const randomUUID = () => globalThis.crypto.randomUUID()
export type MountAgent = (ctx: Context, config: AgentConfig) => Promise<Fiber>

/** 로컬 채팅 실행에 필요한 입력과 이벤트 처리 계약입니다. */
export interface KeundalChatRequest {
  threadId: string
  messages: ChatMessage[]
  instructions: string
  signal?: AbortSignal
  runId?: string
  state?: unknown
  /** A stored journal may be rendered without rerunning the agent or provider. */
  events?: AsyncIterable<AGUIEvent>
  onMessage?: (message: ChatMessage) => void
  /** 실행 중 지시를 받는 대기열입니다. 다음 모델 요청 전의 안전한 경계에서 반영됩니다. */
  steer?: SteerQueue
  onFinish?: (message: ChatMessage, steered: ChatMessageAssembly['steered']) => Promise<void>
}

/** 로컬 채팅의 제목 생성, 응답 실행, 자원 해제 계약입니다. */
export interface KeundalChatRuntime {
  dispose(): Promise<void>
  title(message: ChatMessage, signal?: AbortSignal, titleModel?: string): Promise<string>
  respond(request: KeundalChatRequest): AsyncGenerator<AGUIEvent>
}
const input = (
  messages: AgentMessage[],
  threadId: string = randomUUID(),
  runId: string = randomUUID(),
  state: unknown = {}
) => ({ threadId, runId, state, context: [], tools: [], messages })

export async function createKeundalChat(
  context: Context,
  name: string,
  options: {
    maxActiveSubagents?: number
    subagents?: boolean
    webSearch?: boolean
    reasoning?: Reasoning
    maxOutputTokens?: number
  },
  mountAgent: MountAgent
): Promise<KeundalChatRuntime> {
  const config = resolveModel(name)
  const maxOutputTokens = options.maxOutputTokens ?? 4096
  const ctx = context.isolate('agent')
  const agent = ctx.plugin(async (child: Context) => {
    await mountAgent(child, {
      model: config.value,
      maxOutputTokens,
      webSearch: !!options.webSearch && config.provider !== 'google',
      reasoning:
        options.reasoning !== undefined && config.provider === 'openai' && !/^(gpt-5|o\d)(?:[-.]|$)/.test(config.id)
          ? undefined
          : options.reasoning,
      maxToolRounds: 4,
      subagents: options.subagents ?? true,
      maxActiveSubagents: options.maxActiveSubagents,
      parallelTools: true,
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
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
          if (title.length + event.delta.length > 1024) throw new Error('Generated title exceeds input limit')
          title += event.delta
        }
      }
      return validateChatTitle(title)
    },
    async *respond(request: KeundalChatRequest): AsyncGenerator<AGUIEvent> {
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
            { signal: request.signal, steer: request.steer }
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
        await request.onFinish?.(projection.message, projection.steered)
        publisher.finish(projection.message)
      }
      // The UI sees success only after the display message is durably saved too.
      if (finished) yield finished
    }
  }
}
