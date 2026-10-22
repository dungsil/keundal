import {
  EventType,
  LLMService,
  readTraceSpans,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput
} from '@keundal/core'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStore from '@keundal/plugin-store-memory'
import { expect, test } from 'vitest'

import { createAgentHost } from '../src/index.js'

const input = (threadId: string, runId: string): RunAgentInput => ({
  threadId,
  runId,
  state: {},
  context: [],
  tools: [],
  messages: [{ id: `question:${runId}`, role: 'user', content: 'question' }]
})

const answer = (messageId: string): LLMEvent[] => [
  { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: 'done' },
  { type: EventType.TEXT_MESSAGE_END, messageId }
]

/** 에이전트 플러그인이 받는 도구 설정입니다. 이 패키지는 도구 계약에 직접 의존하지 않습니다. */
type AgentTools = Parameters<typeof agentPlugin>[1]['tools']

async function host(
  stream: (request: LLMRequest, signal?: AbortSignal) => AsyncIterable<LLMEvent>,
  tools: AgentTools = []
) {
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens() {
      return 10
    }
    stream(request: LLMRequest, options?: { signal?: AbortSignal }) {
      return stream(request, options?.signal)[Symbol.asyncIterator]() as AsyncIterableIterator<LLMEvent>
    }
  }
  return createAgentHost({
    model: 'test',
    models: [{ id: 'test', provider: 'test', contextWindow: 2000, maxOutputTokens: 200 }],
    setup: async (ctx) => {
      await ctx.plugin(LLM)
      await ctx.plugin(memoryStore)
    },
    mountAgent: async (ctx, config) => ctx.plugin(agentPlugin, { ...config, tools })
  })
}

test('도구 실행 중 steer한 지시를 같은 실행의 다음 모델 요청에 반영하고 도구를 다시 실행하지 않는다', async () => {
  const requests: LLMRequest[] = []
  const toolStarted = Promise.withResolvers<void>()
  const toolRelease = Promise.withResolvers<void>()
  let executed = 0
  const lookup = {
    name: 'lookup',
    description: 'lookup',
    parameters: { type: 'object', properties: {} },
    async execute() {
      executed++
      toolStarted.resolve()
      await toolRelease.promise
      return 'result'
    }
  }
  const agentHost = await host(
    async function* (request) {
      requests.push(request)
      if (requests.length === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
      } else yield* answer(`answer:${requests.length}`)
    },
    [lookup]
  )
  try {
    const running = Array.fromAsync(agentHost.services.run(input('thread', 'run')))
    await toolStarted.promise
    expect(agentHost.services.steer('run', [{ id: 'steer-1', role: 'user', content: 'first' }])).toBe(1)
    expect(agentHost.services.steer('run', [{ id: 'steer-2', role: 'user', content: 'second' }])).toBe(1)
    // 같은 지시를 다시 보내도 대기 중인 지시는 한 번만 반영합니다.
    expect(agentHost.services.steer('run', [{ id: 'steer-2', role: 'user', content: 'second' }])).toBe(0)
    toolRelease.resolve()
    const events = await running
    expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(executed).toBe(1)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.input.messages.slice(-2).map((message) => message.id)).toEqual(['steer-1', 'steer-2'])
    const stored = await agentHost.services.session.get('thread')
    expect(stored?.messages.map((message) => message.id)).toEqual(expect.arrayContaining(['steer-1', 'steer-2']))
    // 끝난 실행에는 지시를 넣지 않습니다.
    expect(agentHost.services.steer('run', [{ id: 'late', role: 'user', content: 'late' }])).toBe(0)
  } finally {
    await agentHost.dispose()
  }
})

test('같은 대화에는 실행을 하나만 허용하고 다른 대화의 실행은 막지 않는다', async () => {
  const release = Promise.withResolvers<void>()
  const agentHost = await host(async function* (request) {
    if (request.input.threadId === 'busy') await release.promise
    yield* answer(`answer:${request.input.runId}`)
  })
  try {
    const busy = Array.fromAsync(agentHost.services.run(input('busy', 'busy-run')))
    await expect.poll(async () => (await agentHost.services.generation.get('busy-run'))?.status).toBe('running')
    expect(() => agentHost.services.run(input('busy', 'second-run'))).toThrow('thread already has an active run')
    const other = await Array.fromAsync(agentHost.services.run(input('other', 'other-run')))
    expect(other.at(-1)?.type).toBe(EventType.RUN_FINISHED)
    release.resolve()
    expect((await busy).at(-1)?.type).toBe(EventType.RUN_FINISHED)
    const next = await Array.fromAsync(agentHost.services.run(input('busy', 'second-run')))
    expect(next.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  } finally {
    await agentHost.dispose()
  }
})

test('cancel은 실행을 cancelled로 확정하고 구독은 마지막 기록에서 끝난다', async () => {
  const started = Promise.withResolvers<void>()
  let aborted = false
  const agentHost = await host(async function* (_request, signal) {
    yield { type: EventType.TEXT_MESSAGE_START, messageId: 'partial', role: 'assistant' }
    started.resolve()
    await new Promise<void>((_resolve, reject) =>
      signal?.addEventListener(
        'abort',
        () => {
          aborted = true
          reject(signal.reason)
        },
        { once: true }
      )
    )
  })
  try {
    const running = Array.fromAsync(agentHost.services.run(input('thread', 'run'))).catch((error: unknown) => error)
    await started.promise
    const subscription = Array.fromAsync(agentHost.services.subscribe('run'))
    expect(agentHost.services.cancel('run')).toBe(true)
    expect(await running).toBeInstanceOf(Error)
    expect(aborted).toBe(true)
    await expect.poll(async () => (await agentHost.services.generation.get('run'))?.status).toBe('cancelled')
    const entries = await subscription
    const stored = (await agentHost.services.generation.get('run'))!
    expect(entries.map((entry) => entry.sequence)).toEqual(stored.journal.map((entry) => entry.sequence))
    expect(
      entries.some((entry) => entry.event.type === EventType.TEXT_MESSAGE_START && entry.event.messageId === 'partial')
    ).toBe(true)
    expect(entries.some((entry) => entry.event.type === EventType.RUN_FINISHED)).toBe(false)
    expect(
      readTraceSpans(stored.journal.map((entry) => entry.event)).find((span) => span.kind === 'agent')?.status
    ).toBe('cancelled')
    expect(agentHost.services.cancel('run')).toBe(false)
  } finally {
    await agentHost.dispose()
  }
})
