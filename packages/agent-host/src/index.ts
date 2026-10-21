import agentPlugin, { type AgentConfig } from '@keundal/agent'
import { loadAgentPlugin, type AgentPluginOptions, type LoadedAgentPlugin } from '@keundal/agent-plugins'
import {
  EventType,
  type AGUIEvent,
  type AgentMessage,
  type ExecutionOptions,
  type GenerationService,
  type RunAgentInput,
  type SessionService
} from '@keundal/core'
import { McpClient, parseMcpServers, type McpClientConfig } from '@keundal/mcp'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import skillPlugin from '@keundal/plugin-skill'
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
  readonly mcpServers?: readonly McpClientConfig[]
  readonly provider: AgentHostProvider
  readonly apiKey: string
  /** 기본 모델 ID입니다. `models`에 포함되어야 합니다. */
  readonly model: string
  /** 사용할 수 있는 모델과 한도입니다. */
  readonly models?: Readonly<Record<string, Omit<AgentHostModel, 'id' | 'provider'>>>
  readonly sqlitePath: string
  readonly maxOutputTokens?: number
  readonly tools?: AgentConfig['tools']
  readonly plugins?: readonly AgentPluginOptions[]
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
  readonly plugins: readonly LoadedAgentPlugin[]
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

  const mcpServers = parseMcpServers(options.mcpServers ?? [])
  const mcpClients = new Map<string, Promise<McpClient>>()
  const mcpLifetime = new globalThis.AbortController()
  const ctx = new Context()
  const fibers: Fiber[] = []
  const plugins: LoadedAgentPlugin[] = []
  const agents = new Map<string, Promise<Fiber>>()

  const dispose = async () => {
    mcpLifetime.abort()
    const created = await Promise.allSettled(agents.values())
    agents.clear()
    const errors: unknown[] = []
    for (const result of created) {
      if (result.status === 'fulfilled') {
        try {
          await result.value.dispose()
        } catch (error) {
          errors.push(error)
        }
      }
    }
    for (const fiber of fibers.toReversed()) {
      try {
        await fiber.dispose()
      } catch (error) {
        errors.push(error)
      }
    }
    await Promise.allSettled([...mcpClients.values()].map(async (client) => (await client).close()))
    mcpClients.clear()
    const results = await Promise.allSettled(plugins.map((plugin) => plugin.close()))
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'failed to dispose agent host')
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
        skills: plugins.length > 0,
        maxToolRounds: options.maxToolRounds ?? 4,
        tools: async (execution) => {
          const signal = execution?.signal
            ? globalThis.AbortSignal.any([execution.signal, mcpLifetime.signal])
            : mcpLifetime.signal
          const tools = [
            ...(typeof options.tools === 'function' ? await options.tools({ signal }) : (options.tools ?? []))
          ]
          for (const server of mcpServers) {
            signal.throwIfAborted()
            let pending = mcpClients.get(server.serverName)
            if (!pending) {
              pending = McpClient.connect(server, { signal })
              mcpClients.set(server.serverName, pending)
              void pending.catch(() => {
                if (mcpClients.get(server.serverName) === pending) mcpClients.delete(server.serverName)
              })
            }
            try {
              tools.push(...(await (await pending).tools({ signal })))
            } catch (error) {
              if (signal.aborted) throw error
              if (mcpClients.get(server.serverName) === pending) mcpClients.delete(server.serverName)
              await pending.then((client) => client.close()).catch(() => {})
              throw error
            }
          }
          for (const plugin of plugins) tools.push(...(await plugin.tools({ signal })))
          return tools
        }
      })
    })()
    agents.set(id, created)
    created.catch(() => agents.delete(id))
    return created
  }

  try {
    for (const config of options.plugins ?? []) plugins.push(await loadAgentPlugin(config))
    if (plugins.length)
      fibers.push(await ctx.plugin(skillPlugin, { providers: plugins.map((plugin) => plugin.skillProvider) }))
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
          if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
            if (title.length + event.delta.length > 1024) throw new Error('Generated title exceeds input limit')
            title += event.delta
          }
        }
        title = title.trim()
        if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
        return title
      }
    }

    return { ctx, model: options.model, plugins: Object.freeze(plugins), services, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
