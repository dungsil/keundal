import { SteerQueue, EventType, type AgentMessage, type RunAgentInput } from '@keundal/core'
import { parseReasoning, type Reasoning } from '@keundal/llm'
import { retrieveMemories } from '@keundal/memory/retrieval'
import { ToolApproval } from '@keundal/tool-approval'
import { Context, type Fiber } from 'cordis'

import type { AgentHostOptions, AgentHost, AgentHostModel, AgentHostServices } from './contracts.js'
export * from './contracts.js'

/** 호스트가 관리하는 실행 중 실행입니다. */
interface ActiveHostRun {
  readonly runId: string
  readonly abort: AbortController
  readonly steer: SteerQueue
}

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
  const toolApproval = options.toolApproval ?? new ToolApproval({ default: 'allow' })
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
  const runs = new Map<string, ActiveHostRun>()
  const threads = new Map<string, string>()

  const dispose = async () => {
    if (closed) return
    closed = true
    // 진행 중인 실행을 먼저 취소해 종료 커밋이 저장소가 닫히기 전에 확정되게 합니다.
    for (const run of runs.values()) run.abort.abort(new Error('agent host disposed'))
    runs.clear()
    threads.clear()
    await ctx.tasks?.dispose()
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

  const agent = async (
    id: string,
    reasoning?: Reasoning,
    codingThreadId?: string,
    workspacePath?: string
  ): Promise<MountedAgent> => {
    if (closed) throw new Error('agent host disposed')
    const key = JSON.stringify([id, reasoning, codingThreadId, workspacePath])
    const existing = agents.get(key)
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
          reasoning,
          toolApproval,
          codingThreadId,
          workspacePath,
          maxOutputTokens
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
    agents.set(key, created)
    created.catch(() => agents.delete(key))
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
      ...(options.workspaces ? { workspaces: options.workspaces } : {}),
      respondToToolApproval(runId, requestId, decision) {
        return toolApproval.respond(runId, requestId, decision)
      },
      run(input, runOptions = {}) {
        const selected = model(runOptions.model)
        const { model: _model, reasoning: rawReasoning, steer: _steer, ...execution } = runOptions
        const reasoning = parseReasoning(rawReasoning)
        if (runs.has(input.runId)) throw new Error(`generation run is already active: ${input.runId}`)
        const activeThread = threads.get(input.threadId)
        if (activeThread) throw new Error(`thread already has an active run: ${input.threadId}`)
        const abort = new AbortController()
        const steer = new SteerQueue()
        const active: ActiveHostRun = { runId: input.runId, abort, steer }
        runs.set(input.runId, active)
        threads.set(input.threadId, input.runId)
        const signal = execution.signal ? AbortSignal.any([execution.signal, abort.signal]) : abort.signal
        const iterator = (async function* () {
          try {
            const workspace = await options.workspaces?.get(input.threadId)
            signal.throwIfAborted()
            const fiber = await agent(selected.id, reasoning, workspace?.threadId, workspace?.path)
            yield* fiber.ctx.agent.run(input, { ...execution, signal, steer })
          } finally {
            // 남은 지시는 실행이 끝난 뒤 반영할 수 없으므로 대기열을 닫습니다.
            steer.close()
            if (runs.get(active.runId) === active) runs.delete(active.runId)
            if (threads.get(input.threadId) === active.runId) threads.delete(input.threadId)
          }
        })()
        return iterator
      },
      steer(runId, messages) {
        return runs.get(runId)?.steer.push(messages) ?? 0
      },
      cancel(runId) {
        const active = runs.get(runId)
        if (!active) return false
        active.abort.abort(new Error('run cancelled'))
        return true
      },
      subscribe(runId, subscriptionOptions) {
        return servicesContext.generation.subscribe(runId, subscriptionOptions)
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
      ...(servicesContext.memory
        ? {
            memory: {
              list: (execution) => servicesContext.memory.list(execution),
              save: (draft, id, execution) => servicesContext.memory.save(draft, id, execution),
              delete: (id, execution) => servicesContext.memory.delete(id, execution),
              search: ({ model: selected, ...query }, execution) =>
                selected
                  ? retrieveMemories(servicesContext.memory, servicesContext.llm, query, model(selected).id, execution)
                  : servicesContext.memory.search(query, execution)
            } satisfies NonNullable<AgentHostServices['memory']>
          }
        : {}),
      ...(servicesContext.tasks
        ? {
            tasks: {
              get: (id: string) => servicesContext.tasks.get(id),
              list: (query?: { parentThreadId?: string }) => servicesContext.tasks.list(query),
              cancel: (id: string) => servicesContext.tasks.cancel(id)
            }
          }
        : {}),
      models: () => models,
      async catalog(execution = {}) {
        if (closed) throw new Error('agent host disposed')
        const skills = servicesContext.skills ? (await servicesContext.skills.prepare(execution)).skills : []
        const tools = (await options.toolCatalog?.(execution)) ?? []
        return { skills, tools }
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
