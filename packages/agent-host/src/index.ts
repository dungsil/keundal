import agentPlugin, { type AgentConfig } from '@keundal/agent'
import {
  EventType,
  type AGUIEvent,
  type AgentMessage,
  type ExecutionOptions,
  type GenerationService,
  type RunAgentInput,
  type SessionService
} from '@keundal/core'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { Context, type Fiber } from 'cordis'

export interface AgentHostModel {
  readonly id: string
  readonly provider: AgentHostProvider
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

export type AgentHostProvider = 'openai' | 'gemini' | 'anthropic'

export interface AgentHostOptions {
  readonly provider: AgentHostProvider
  readonly apiKey: string
  /** 기본 모델 ID입니다. `models`에 포함되어야 합니다. */
  readonly model: string
  /** 사용할 수 있는 모델과 한도입니다. */
  readonly models?: Readonly<Record<string, Omit<AgentHostModel, 'id' | 'provider'>>>
  readonly sqlitePath: string
  readonly maxOutputTokens?: number
  readonly tools?: AgentConfig['tools']
  readonly maxToolRounds?: number
  readonly baseURL?: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface AgentHostRunOptions extends ExecutionOptions {
  readonly model?: string
}

export interface AgentHostTitleRequest {
  readonly model: string
  readonly message: AgentMessage
}

/** HTTP 계층과 sidecar가 공통으로 사용하는 에이전트 표면입니다. */
export interface AgentHostServices {
  run(input: RunAgentInput, options?: AgentHostRunOptions): AsyncIterable<AGUIEvent>
  session: Pick<SessionService, 'get' | 'list' | 'commit' | 'delete'>
  generation: Pick<GenerationService, 'get' | 'list' | 'recover'>
  models(): readonly AgentHostModel[]
  title(request: AgentHostTitleRequest, options?: ExecutionOptions): Promise<string>
}

export interface AgentHost {
  readonly ctx: Context
  readonly model: string
  readonly services: AgentHostServices
  dispose(): Promise<void>
}

const providerPlugins = {
  openai: openaiLLMPlugin,
  gemini: geminiLLMPlugin,
  anthropic: anthropicLLMPlugin
} as const

const input = (messages: AgentMessage[]): RunAgentInput => ({
  threadId: globalThis.crypto.randomUUID(),
  runId: globalThis.crypto.randomUUID(),
  state: {},
  context: [],
  tools: [],
  messages
})

const titleInstructions =
  'Generate a chat title under 30 characters from the first user message. No quotes, punctuation, markdown, or commentary. Return only the title.'

/**
 * Keundal 서비스와 플러그인을 조립해 Node.js 호스트를 만듭니다.
 * HTTP 전송과 프로세스 수명은 호출자가 담당합니다.
 */
export async function createAgentHost(options: AgentHostOptions): Promise<AgentHost> {
  if (!options.model.trim()) throw new Error('model is required')
  const configured = options.models ?? {
    [options.model]: { contextWindow: 128_000, maxOutputTokens: 4_096 }
  }
  const modelIds = Object.keys(configured)
  if (!modelIds.includes(options.model)) {
    throw new Error(`default model is not configured: ${options.model}`)
  }
  const models: AgentHostModel[] = modelIds.map((id) => ({ id, provider: options.provider, ...configured[id]! }))
  const limits = new Map(models.map((model) => [model.id, model]))

  const ctx = new Context()
  const fibers: Fiber[] = []
  const agents = new Map<string, Promise<Fiber>>()

  const dispose = async () => {
    const created = await Promise.allSettled(agents.values())
    agents.clear()
    for (const result of created) {
      if (result.status === 'fulfilled') await result.value.dispose()
    }
    for (const fiber of fibers.toReversed()) await fiber.dispose()
  }

  const model = (id: string | undefined): AgentHostModel => {
    const selected = id ?? options.model
    const value = limits.get(selected)
    if (!value) throw new Error(`model is not configured: ${selected}`)
    return value
  }

  const agent = async (id: string): Promise<Fiber> => {
    const existing = agents.get(id)
    if (existing) return existing
    const created = (async () => {
      const selected = model(id)
      const maxOutputTokens = Math.min(
        options.maxOutputTokens ?? 4_096,
        selected.maxOutputTokens,
        selected.contextWindow - 1
      )
      if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
        throw new Error(`invalid output budget for model: ${id}`)
      }
      const isolated = ctx.isolate('agent')
      return isolated.plugin(agentPlugin, {
        model: selected.id,
        maxOutputTokens,
        tools: options.tools,
        maxToolRounds: options.maxToolRounds ?? 4
      })
    })()
    agents.set(id, created)
    created.catch(() => agents.delete(id))
    return created
  }

  try {
    fibers.push(
      await ctx.plugin(providerPlugins[options.provider], {
        apiKey: options.apiKey,
        baseURL: options.baseURL,
        headers: options.headers,
        models: Object.fromEntries(
          models.map((item) => [
            item.id,
            {
              contextWindow: item.contextWindow,
              maxOutputTokens: item.maxOutputTokens
            }
          ])
        )
      })
    )
    fibers.push(await ctx.plugin(sqliteStorePlugin, { path: options.sqlitePath }))

    const services: AgentHostServices = {
      run(input, runOptions = {}) {
        const selected = model(runOptions.model)
        const { model: _model, ...execution } = runOptions
        const iterator = (async function* () {
          const fiber = await agent(selected.id)
          yield* fiber.ctx.agent.run(input, execution)
        })()
        return iterator
      },
      session: {
        get: (threadId, runOptions) => ctx.session.get(threadId, runOptions),
        list: (runOptions) => ctx.session.list(runOptions),
        commit: (change, runOptions) => ctx.session.commit(change, runOptions),
        delete: (threadId, revision, runOptions) => ctx.session.delete(threadId, revision, runOptions)
      },
      generation: {
        get: (runId, runOptions) => ctx.generation.get(runId, runOptions),
        list: (runOptions) => ctx.generation.list(runOptions),
        recover: (runOptions) => ctx.generation.recover(runOptions)
      },
      models: () => models,
      async title(request, runOptions) {
        const selected = model(request.model)
        const maxOutputTokens = Math.min(256, selected.maxOutputTokens, selected.contextWindow - 1)
        let title = ''
        for await (const event of ctx.llm.stream(
          {
            model: selected.id,
            maxOutputTokens,
            input: input([
              { id: globalThis.crypto.randomUUID(), role: 'system', content: titleInstructions },
              { id: request.message.id, role: 'user', content: JSON.stringify(request.message) }
            ])
          },
          runOptions
        )) {
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) title += event.delta
        }
        return title.trim()
      }
    }

    return { ctx, model: options.model, services, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
