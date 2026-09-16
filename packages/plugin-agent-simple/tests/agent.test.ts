import { getEventListeners } from 'node:events'

import {
  CompactionService,
  EventType,
  GenerationService,
  LLMService,
  SessionService,
  type AGUIEvent,
  type CompactionRequest,
  type CompactionResult,
  type ExecutionOptions,
  type GenerationRequest,
  type LLMModel,
  type LLMRequest,
  type PreparedSession,
  type RunAgentInput
} from '@keundal/core'
import simpleAgentPlugin from '@keundal/plugin-agent-simple'
import { Context, type Fiber } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  messages: [{ id: 'question', role: 'user', content: 'question' }],
  tools: [],
  context: []
}
const config = { model: 'test-model', maxOutputTokens: 20 }
const events: AGUIEvent[] = [
  { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
  { type: EventType.TEXT_MESSAGE_START, messageId: 'reply', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'reply', delta: 'response' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'reply' },
  { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run', outcome: { type: 'success' } }
]
const collect = async (stream: AsyncIterable<AGUIEvent>): Promise<AGUIEvent[]> => {
  const result: AGUIEvent[] = []
  for await (const event of stream) result.push(event)
  return result
}
const unexpected = (): never => {
  throw new Error('composition called an implementation-only operation')
}
const getSignal = (options?: ExecutionOptions): AbortSignal => {
  if (!options?.signal) throw new Error('composition must forward a cancellation signal')
  return options.signal
}

interface Overrides {
  getModel?: (model: string, options?: ExecutionOptions) => LLMModel | Promise<LLMModel>
  countTokens?: (request: LLMRequest, options?: ExecutionOptions) => number | Promise<number>
  prepare?: (request: RunAgentInput, options?: ExecutionOptions) => PreparedSession | Promise<PreparedSession>
  compact?: (request: CompactionRequest, options?: ExecutionOptions) => CompactionResult | Promise<CompactionResult>
  run?: GenerationService['run']
}

async function setup(testContext: TestContext, overrides: Overrides = {}) {
  const ctx = new Context()
  const calls: string[] = []
  const generations: { request: GenerationRequest; options?: ExecutionOptions }[] = []
  const constructed = { llm: 0, session: 0, compaction: 0, generation: 0 }
  class LLM extends LLMService {
    constructor(ctx: Context) {
      super(ctx)
      constructed.llm++
    }
    async getModel(model: string, options?: ExecutionOptions): Promise<LLMModel> {
      calls.push('model')
      return overrides.getModel?.(model, options) ?? { contextWindow: 100, maxOutputTokens: 30 }
    }
    async countTokens(request: LLMRequest, options?: ExecutionOptions): Promise<number> {
      calls.push('count')
      if (overrides.countTokens) return overrides.countTokens(request, options)
      return request.input.messages.reduce(
        (count, message) =>
          count + ('content' in message && typeof message.content === 'string' ? message.content.length : 0),
        0
      )
    }
    stream = unexpected
  }
  class Session extends SessionService {
    constructor(ctx: Context) {
      super(ctx)
      constructed.session++
    }
    async prepare(request: RunAgentInput, options?: ExecutionOptions): Promise<PreparedSession> {
      calls.push('prepare')
      return overrides.prepare?.(request, options) ?? { input: globalThis.structuredClone(request), revision: 7 }
    }
    get = unexpected
    commit = unexpected
  }
  class Compaction extends CompactionService {
    constructor(ctx: Context) {
      super(ctx)
      constructed.compaction++
    }
    async compact(request: CompactionRequest, options?: ExecutionOptions): Promise<CompactionResult> {
      calls.push('compact')
      if (overrides.compact) return overrides.compact(request, options)
      return {
        messages: [{ id: 'summary', role: 'system', content: 'summary' }],
        summary: 'summary',
        sourceMessageIds: request.input.messages.map((message) => message.id)
      }
    }
  }
  class Generation extends GenerationService {
    constructor(ctx: Context) {
      super(ctx)
      constructed.generation++
    }
    run(request: GenerationRequest, options?: ExecutionOptions): AsyncIterable<AGUIEvent> {
      calls.push('run')
      generations.push({ request, options })
      if (overrides.run) return overrides.run(request, options)
      return (async function* () {
        yield* events
      })()
    }
    get = unexpected
    recover = unexpected
  }
  const fibers: Fiber[] = []
  testContext.onTestFinished(async () => {
    for (const fiber of fibers.toReversed()) await fiber.dispose()
  })
  const llmFiber = await ctx.plugin(LLM)
  fibers.push(llmFiber, await ctx.plugin(Session), await ctx.plugin(Generation))
  const pendingAgent = ctx.plugin(simpleAgentPlugin, config)
  expect(ctx.agent, 'composition must wait for all four services').toBeUndefined()
  fibers.push(await ctx.plugin(Compaction))
  const agentFiber = await pendingAgent
  fibers.push(agentFiber)
  return { ctx, calls, generations, agentFiber, llmFiber, LLM, fibers, constructed }
}

test('prepares the session and forwards generation events without owning execution or persistence', async (t) => {
  const { ctx, calls, generations } = await setup(t, {
    prepare: (request) => ({
      input: { ...request, messages: [{ id: 'history', role: 'user', content: 'saved history' }] },
      revision: 12
    })
  })
  const result = await collect(ctx.agent.run(input))
  expect(calls).toStrictEqual(['prepare', 'model', 'count', 'run'])
  expect(generations[0].request).toStrictEqual({
    input: { ...input, messages: [{ id: 'history', role: 'user', content: 'saved history' }] },
    model: 'test-model',
    maxOutputTokens: 20,
    sessionRevision: 12
  })
  expect(result).toStrictEqual(events)
  expect(result[0]).toBe(events[0])
  expect(result.at(-1)).toBe(events.at(-1))
})

test('compacts over-budget context, rechecks its size, and forwards provenance without changing source messages', async (t) => {
  const original: RunAgentInput = { ...input, messages: [{ id: 'history', role: 'user', content: 'x'.repeat(81) }] }
  const snapshot = globalThis.structuredClone(original)
  let compactionRequest: CompactionRequest | undefined
  const { ctx, calls, generations } = await setup(t, {
    compact: (request) => {
      compactionRequest = request
      return {
        messages: [{ id: 'summary', role: 'system', content: 'short' }],
        summary: 'short',
        sourceMessageIds: ['history']
      }
    }
  })
  await collect(ctx.agent.run(original))
  expect(calls).toStrictEqual(['prepare', 'model', 'count', 'compact', 'count', 'run'])
  expect(compactionRequest?.maxInputTokens).toBe(80)
  expect(compactionRequest?.model).toBe('test-model')
  expect(original).toStrictEqual(snapshot)
  expect(generations[0].request.compaction?.sourceMessageIds).toStrictEqual(['history'])
  expect(generations[0].request.input.messages).toStrictEqual([{ id: 'summary', role: 'system', content: 'short' }])
  expect(generations[0].request.sessionRevision).toBe(7)
})

test('context exactly fitting the input budget does not need compaction', async (t) => {
  const { ctx, calls } = await setup(t)
  await collect(ctx.agent.run({ ...input, messages: [{ id: 'question', role: 'user', content: 'x'.repeat(80) }] }))
  expect(calls).toStrictEqual(['prepare', 'model', 'count', 'run'])
})

test('an oversized compaction result does not start generation', async (t) => {
  const { ctx, calls, generations } = await setup(t, { countTokens: () => 81 })
  await expect(collect(ctx.agent.run(input))).rejects.toThrow(/compacted input still exceeds/)
  expect(calls).toStrictEqual(['prepare', 'model', 'count', 'compact', 'count'])
  expect(generations).toHaveLength(0)
})

test('invalid model budgets and changed session identity fail before generation starts', async (t) => {
  const badBudget = await setup(t, { getModel: () => ({ contextWindow: 100, maxOutputTokens: 10 }) })
  await expect(collect(badBudget.ctx.agent.run(input))).rejects.toThrow(/output budget/)
  expect(badBudget.calls).toStrictEqual(['prepare', 'model'])
  const badIdentity = await setup(t, {
    prepare: (request) => ({ input: { ...request, threadId: 'different-thread' }, revision: 1 })
  })
  await expect(collect(badIdentity.ctx.agent.run(input))).rejects.toThrow(/preserve threadId and runId/)
  expect(badIdentity.calls).toStrictEqual(['prepare'])
})

test('pre-start cancellation and returning an unused iterator do not retain abort listeners or run services', async (t) => {
  const { ctx, calls } = await setup(t)
  const external = new globalThis.AbortController()
  const baseline = getEventListeners(external.signal, 'abort').length
  const unused = ctx.agent.run(input, { signal: external.signal })
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(baseline + 1)
  await unused.return!()
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(baseline)
  const reason = new Error('cancelled before start')
  external.abort(reason)
  await expect(collect(ctx.agent.run(input, { signal: external.signal }))).rejects.toBe(reason)
  expect(calls).toStrictEqual([])
})

test('returning during session preparation aborts before waiting and prevents generation', async (t) => {
  const started = Promise.withResolvers<void>()
  let preparationSignal: AbortSignal | undefined
  const { ctx, generations } = await setup(t, {
    prepare: (_request, options) =>
      new Promise<PreparedSession>((_resolve, reject) => {
        const signal = getSignal(options)
        preparationSignal = signal
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        started.resolve()
      })
  })
  const iterator = ctx.agent.run(input)
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow(/run stopped/)
  await started.promise
  const returned = iterator.return!()
  expect(preparationSignal?.aborted).toBe(true)
  await rejected
  expect((await returned).done).toBe(true)
  expect(generations).toHaveLength(0)
})

test('disposing the composition aborts the delegated generation and closes its iterator', async (t) => {
  const started = Promise.withResolvers<void>()
  let executionSignal: AbortSignal | undefined
  let closed = false
  const { ctx, agentFiber } = await setup(t, {
    run: (_request, options) =>
      (async function* () {
        const signal = getSignal(options)
        executionSignal = signal
        try {
          yield events[0]
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true })
            started.resolve()
          })
        } finally {
          closed = true
        }
      })()
  })
  const external = new globalThis.AbortController()
  const iterator = ctx.agent.run(input, { signal: external.signal })
  await iterator.next()
  const pending = iterator.next()
  const rejected = expect(pending).rejects.toThrow(/disposed/)
  await started.promise
  await agentFiber.dispose()
  await rejected
  expect(executionSignal?.aborted).toBe(true)
  expect(closed).toBe(true)
  expect(getEventListeners(external.signal, 'abort')).toHaveLength(0)
  expect(ctx.agent).toBeUndefined()
})

test('replacing an injected LLM rebuilds the composition without replacing the other services', async (t) => {
  const { ctx, llmFiber, LLM, fibers, constructed } = await setup(t)
  const previousAgent = ctx.agent
  expect(constructed).toStrictEqual({ llm: 1, session: 1, compaction: 1, generation: 1 })
  await llmFiber.dispose()
  expect(ctx.agent).toBeUndefined()
  expect(() => previousAgent.run(input)).toThrow(/disposed/)
  fibers.push(await ctx.plugin(LLM))
  // Cordis activates the dependent plugin after the replacement service becomes available.
  await ctx.agent.run(input).return!()
  expect(ctx.agent).not.toBe(previousAgent)
  expect(constructed).toStrictEqual({ llm: 2, session: 1, compaction: 1, generation: 1 })
  expect(await collect(ctx.agent.run(input))).toStrictEqual(events)
})
