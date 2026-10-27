import { AgentService } from '@keundal/agent'
import { EventType, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMEvent } from '@keundal/llm'
import memoryStore from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

import { createAgentHost, type AgentHostOptions } from '../src/index.js'

const input: RunAgentInput = { threadId: 'thread', runId: 'run', state: {}, context: [], tools: [], messages: [] }

function composition(disposed: string[]): AgentHostOptions {
  class LLM extends LLMService {
    constructor(ctx: Context) {
      super(ctx)
      ctx.effect(() => () => {
        disposed.push('llm')
      })
    }
    async getModel() {
      return { contextWindow: 1000, maxOutputTokens: 100 }
    }
    async countTokens() {
      return 1
    }
    async *stream(): AsyncIterable<LLMEvent> {
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'title', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'title', delta: 'Custom title' }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'title' }
    }
  }
  class CustomAgent extends AgentService {
    constructor(ctx: Context) {
      super(ctx)
      ctx.effect(() => () => {
        disposed.push('agent')
      })
    }
    async *run(request: RunAgentInput): AsyncGenerator<AGUIEvent> {
      yield { type: EventType.RUN_STARTED, threadId: request.threadId, runId: request.runId }
      yield { type: EventType.RUN_FINISHED, threadId: request.threadId, runId: request.runId }
    }
  }
  return {
    model: 'custom',
    models: [{ id: 'custom', provider: 'custom-provider', contextWindow: 1000, maxOutputTokens: 100 }],
    setup: async (ctx) => {
      await ctx.plugin(LLM)
      await ctx.plugin(memoryStore)
    },
    mountAgent: async (ctx) => ctx.plugin(CustomAgent)
  }
}

test('호스트는 외부 LLM·메모리 저장소·독립 에이전트 구현을 주입받아 실행한다', async () => {
  const disposed: string[] = []
  const host = await createAgentHost(composition(disposed))
  try {
    expect(host.services.models()[0]?.provider).toBe('custom-provider')
    expect(await Array.fromAsync(host.services.run(input))).toEqual([
      { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
      { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' }
    ])
    expect(
      await host.services.title({ model: 'custom', message: { id: 'user', role: 'user', content: 'Hello' } })
    ).toBe('Custom title')
    expect(await host.services.session.list()).toEqual([])
  } finally {
    await host.dispose()
  }
  await host.dispose()
  expect(disposed).toEqual(['agent', 'llm'])
  await expect(Array.fromAsync(host.services.run(input))).rejects.toThrow('disposed')
})

test('호스트 초기화가 실패하면 이미 등록한 서비스도 해제한다', async () => {
  const disposed: string[] = []
  const config = composition(disposed)
  await expect(
    createAgentHost({
      ...config,
      setup: async (ctx) => {
        await config.setup(ctx)
        throw new Error('setup failed')
      }
    })
  ).rejects.toThrow('setup failed')
  expect(disposed).toEqual(['llm'])
})

test('필수 서비스가 누락되면 호스트 시작을 거부하고 플러그인을 정리한다', async () => {
  const disposed: string[] = []
  const config = composition(disposed)
  await expect(
    createAgentHost({
      ...config,
      setup: async (ctx) => {
        ctx.effect(() => () => {
          disposed.push('scope')
        })
      }
    })
  ).rejects.toThrow('missing host service')
  expect(disposed).toEqual(['scope'])
})

test('에이전트 등록이 실패하면 부분 등록한 자원을 정리하고 다음 실행에서 다시 등록한다', async () => {
  const disposed: string[] = []
  const config = composition(disposed)
  let attempts = 0
  const host = await createAgentHost({
    ...config,
    mountAgent: async (ctx, options) => {
      attempts++
      ctx.effect(() => () => {
        disposed.push('attempt')
      })
      if (attempts === 1) throw new Error('agent setup failed')
      return config.mountAgent(ctx, options)
    }
  })
  try {
    await expect(Array.fromAsync(host.services.run(input))).rejects.toThrow('agent setup failed')
    expect(disposed).toEqual(['attempt'])
    expect((await Array.fromAsync(host.services.run(input))).at(-1)?.type).toBe(EventType.RUN_FINISHED)
    expect(attempts).toBe(2)
  } finally {
    await host.dispose()
  }
  expect(disposed.filter((value) => value === 'attempt')).toHaveLength(2)
})
