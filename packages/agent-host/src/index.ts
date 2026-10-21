import { EventType, type AgentMessage, type RunAgentInput } from '@keundal/core'
import { Context, type Fiber } from 'cordis'

import type { AgentHostOptions, AgentHost, AgentHostModel, AgentHostServices } from './contracts.js'
export * from './contracts.js'

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
  const models = [...options.models]
  if (!models.some((model) => model.id === options.model))
    throw new Error(`default model is not configured: ${options.model}`)
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('duplicate model id')
  const limits = new Map(models.map((model) => [model.id, model]))

  const ctx = new Context()
  let scope: Fiber | undefined
  let closed = false
  type MountedAgent = { ctx: Context; dispose(): Promise<void> }
  const agents = new Map<string, Promise<MountedAgent>>()

  const dispose = async () => {
    if (closed) return
    closed = true
    const created = await Promise.allSettled(agents.values())
    agents.clear()
    const disposed = await Promise.allSettled(
      created.flatMap((result) => (result.status === 'fulfilled' ? [result.value.dispose()] : []))
    )
    disposed.push(...(await Promise.allSettled([scope?.dispose()])))
    const errors = disposed.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'failed to dispose agent host')
  }

  const model = (id: string | undefined): AgentHostModel => {
    const selected = id ?? options.model
    const value = limits.get(selected)
    if (!value) throw new Error(`model is not configured: ${selected}`)
    return value
  }

  const agent = async (id: string): Promise<MountedAgent> => {
    if (closed) throw new Error('agent host disposed')
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
      const owned = isolated.plugin(async (child: Context) => {
        await options.mountAgent(child, {
          model: selected.id,
          maxOutputTokens,
          tools: options.tools,
          maxToolRounds: options.maxToolRounds ?? 4
        })
      })
      try {
        await owned
        return { ctx: isolated, dispose: () => owned.dispose() }
      } catch (error) {
        await owned.dispose()
        throw error
      }
    })()
    agents.set(id, created)
    created.catch(() => agents.delete(id))
    return created
  }

  try {
    scope = ctx.plugin(async (owned: Context) => {
      await options.setup(owned)
    })
    await scope
    const servicesContext = ctx
    for (const name of ['llm', 'session', 'generation'] as const) {
      if (!servicesContext[name]) throw new Error(`missing host service: ${name}`)
    }

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
        get: (threadId, runOptions) => servicesContext.session.get(threadId, runOptions),
        list: (runOptions) => servicesContext.session.list(runOptions),
        commit: (change, runOptions) => servicesContext.session.commit(change, runOptions),
        delete: (threadId, revision, runOptions) => servicesContext.session.delete(threadId, revision, runOptions)
      },
      generation: {
        get: (runId, runOptions) => servicesContext.generation.get(runId, runOptions),
        list: (runOptions) => servicesContext.generation.list(runOptions),
        recover: (runOptions) => servicesContext.generation.recover(runOptions)
      },
      models: () => models,
      async catalog(execution = {}) {
        if (closed) throw new Error('agent host disposed')
        const skills = servicesContext.skills ? (await servicesContext.skills.prepare(execution)).skills : []
        const tools = typeof options.tools === 'function' ? await options.tools(execution) : (options.tools ?? [])
        return { skills, tools: tools.map(({ name, description }) => ({ name, description })) }
      },
      async title(request, runOptions) {
        const selected = model(request.model)
        const maxOutputTokens = Math.min(256, selected.maxOutputTokens, selected.contextWindow - 1)
        let title = ''
        for await (const event of servicesContext.llm.stream(
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

    return { ctx: servicesContext, model: options.model, services, dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}
