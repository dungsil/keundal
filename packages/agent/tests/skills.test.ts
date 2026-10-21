import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import agentPlugin, { AgentConfigSchema, type AgentConfig } from '@keundal/agent'
import {
  EventType,
  LLMService,
  type AGUIEvent,
  type LLMEvent,
  type LLMRequest,
  type RunAgentInput,
  type SkillProvider
} from '@keundal/core'
import skillPlugin from '@keundal/plugin-skill'
import filesystemSkillPlugin from '@keundal/plugin-skill-filesystem'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input: RunAgentInput = {
  threadId: 'thread',
  runId: 'run',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'Review this change' }]
}
const answer: LLMEvent[] = [
  { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Reviewed' },
  { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
]
const call = (name: string): LLMEvent[] => [
  { type: EventType.TOOL_CALL_START, toolCallId: 'load', toolCallName: 'skill' },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 'load', delta: JSON.stringify({ name }) },
  { type: EventType.TOOL_CALL_END, toolCallId: 'load' }
]
async function collect(stream: AsyncIterable<AGUIEvent>) {
  const events = []
  for await (const event of stream) events.push(event)
  return events
}
async function setup(
  t: TestContext,
  scripts: LLMEvent[][] = [answer],
  count?: (request: LLMRequest) => number,
  tools?: AgentConfig['tools']
) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  const counted: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 200 }
    }
    async countTokens(request: LLMRequest) {
      counted.push(structuredClone(request))
      return count?.(request) ?? 10
    }
    async *stream(request: LLMRequest) {
      const index = requests.length
      requests.push(structuredClone(request))
      if (!scripts[index]) throw new Error('unexpected LLM call')
      yield* scripts[index].map((event) =>
        'messageId' in event && event.messageId === 'answer'
          ? { ...event, messageId: `answer:${request.input.runId}` }
          : event
      )
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const registry = await ctx.plugin(skillPlugin)
  t.onTestFinished(async () => {
    await registry.dispose()
    await store.dispose()
    await llm.dispose()
  })
  const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100, skills: true, tools })
  t.onTestFinished(() => agent.dispose())
  return { ctx, requests, counted, registry, agent }
}
const provider = (load: SkillProvider['prepare']): SkillProvider => ({ name: 'test', prepare: load })

test('파일 스킬을 도구로 불러와 후속 생성과 세션에 기록하고 복구 시 다시 읽지 않는다', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'keundal-agent-skills-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'review'))
  const path = join(root, 'review', 'SKILL.md')
  await writeFile(path, '---\nname: review\ndescription: Review changes\n---\nInspect public behavior.')
  const { ctx, requests, counted } = await setup(t, [call('review'), answer])
  const filesystem = await ctx.plugin(filesystemSkillPlugin, { roots: [root] })
  t.onTestFinished(() => filesystem.dispose())
  const events = await collect(ctx.agent.run(input))
  expect(requests).toHaveLength(2)
  expect(requests[0].input.messages[0]).toMatchObject({
    role: 'system',
    content: expect.stringContaining('review: Review changes')
  })
  expect(JSON.stringify(requests[0])).not.toContain('Inspect public behavior.')
  expect(requests[0].input.tools.map((tool) => tool.name)).toEqual(['skill'])
  const result = {
    role: 'tool',
    toolCallId: 'load',
    content: '<skill_content name="review">\nInspect public behavior.\n</skill_content>'
  }
  expect(requests[1].input.messages).toContainEqual(expect.objectContaining(result))
  expect(counted.at(-1)?.input.messages).toContainEqual(expect.objectContaining(result))
  expect((await ctx.session.get('thread'))?.messages).toContainEqual(expect.objectContaining(result))
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
  await rm(path)
  await ctx.generation.recover()
  expect((await ctx.generation.get('run'))?.status).toBe('completed')
  expect(requests).toHaveLength(2)
})

test('현재 목록으로 기존 메시지를 대체하고 빈 목록과 사용 해제를 반영한다', async (t) => {
  const { ctx, requests, agent } = await setup(t, [answer, answer, answer, answer])
  const dispose = ctx.skills.registerProvider(
    provider(async () => ({
      skills: [{ name: 'review', description: 'One\n  two' }],
      async load() {
        return undefined
      }
    }))
  )
  await collect(ctx.agent.run(input))
  const catalog = requests[0].input.messages[0]
  expect(catalog.content).toContain('review: One two')
  await ctx.session.commit({ threadId: 'thread', expectedRevision: 1, messages: [catalog], state: {} })
  dispose()
  await collect(ctx.agent.run({ ...input, runId: 'empty' }))
  expect(requests[1].input.messages.filter((message) => message.id === catalog.id)).toHaveLength(1)
  expect(requests[1].input.messages.find((message) => message.id === catalog.id)?.content).toContain('(none)')
  expect(JSON.stringify(requests[1].input.messages)).not.toContain('One two')
  await agent.dispose()
  const disabled = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100 })
  t.onTestFinished(() => disabled.dispose())
  await collect(ctx.agent.run({ ...input, runId: 'disabled' }))
  expect(requests[2].input.tools).toEqual([])
  expect(requests[2].input.messages.find((message) => message.id === catalog.id)?.content).toContain('disabled')
  await expect(collect(ctx.agent.run({ ...input, runId: 'reserved', messages: [catalog] }))).rejects.toThrow(
    'message id is reserved'
  )
})

test('없는 스킬은 도구 결과로 안내하고 큰 본문은 후속 생성 전에 예산 초과로 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, [call('missing'), answer, call('huge')], (request) =>
    request.input.messages.some((message) => message.content?.includes('Oversized body')) ? 2001 : 10
  )
  ctx.skills.registerProvider(
    provider(async () => ({
      skills: [{ name: 'huge', description: 'Large instructions' }],
      async load(name) {
        return { name, description: 'Large instructions', content: 'Oversized body' }
      }
    }))
  )
  await collect(ctx.agent.run(input))
  expect(requests[1].input.messages).toContainEqual(
    expect.objectContaining({ role: 'tool', content: expect.stringContaining('Unknown skill: missing') })
  )
  await expect(collect(ctx.agent.run({ ...input, threadId: 'large-thread', runId: 'large' }))).rejects.toThrow(
    'no older conversation can be compacted'
  )
  expect(requests).toHaveLength(3)
  expect((await ctx.generation.get('large'))?.status).toBe('failed')
})

test('서비스 해제는 진행 중 본문 로딩을 취소하고 에이전트를 중단한다', async (t) => {
  const { ctx, registry } = await setup(t, [call('review')])
  const started = Promise.withResolvers<void>()
  ctx.skills.registerProvider(
    provider(async () => ({
      skills: [{ name: 'review', description: 'Review' }],
      async load(_name, options) {
        started.resolve()
        const signal = options!.signal!
        await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        return undefined
      }
    }))
  )
  const task = collect(ctx.agent.run(input))
  const rejected = expect(task).rejects.toThrow()
  await started.promise
  await registry.dispose()
  await rejected
  expect((await ctx.generation.get('run'))?.status).not.toBe('completed')
})

test('목록 준비가 취소되거나 목록만으로 예산을 넘으면 생성을 시작하지 않는다', async (t) => {
  const { ctx, requests } = await setup(t, [answer], (request) =>
    JSON.stringify(request.input).includes('Long description') ? 2001 : 10
  )
  const started = Promise.withResolvers<void>()
  const dispose = ctx.skills.registerProvider(
    provider(async (options) => {
      started.resolve()
      const signal = options!.signal!
      await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      throw new Error('unreachable')
    })
  )
  const controller = new AbortController()
  const task = collect(ctx.agent.run(input, { signal: controller.signal }))
  const rejected = expect(task).rejects.toThrow('cancel preparation')
  await started.promise
  controller.abort(new Error('cancel preparation'))
  await rejected
  dispose()
  ctx.skills.registerProvider(
    provider(async () => ({
      skills: [{ name: 'review', description: 'Long description' }],
      async load() {
        return undefined
      }
    }))
  )
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('no older conversation can be compacted')
  expect(requests).toEqual([])
  expect(await ctx.generation.get('run')).toBeUndefined()
})

test('스킬 서비스가 돌아오면 활성화한 에이전트를 다시 구성한다', async (t) => {
  const { ctx, registry } = await setup(t)
  const original = ctx.agent
  await registry.dispose()
  const replacement = await ctx.plugin(skillPlugin)
  t.onTestFinished(() => replacement.dispose())
  expect(ctx.agent).not.toBe(original)
  expect(() => original.run(input)).toThrow('disposed')
  await collect(ctx.agent.run(input))
  expect((await ctx.generation.get('run'))?.status).toBe('completed')
})

test('스킬 설정은 boolean만 받고 자동 로더와 같은 이름의 도구를 거부한다', async () => {
  const config = { model: 'test', maxOutputTokens: 100 }
  expect((await AgentConfigSchema['~standard'].validate({ ...config, skills: 'yes' })).issues).toBeDefined()
  expect(
    (
      await AgentConfigSchema['~standard'].validate({
        ...config,
        skills: true,
        tools: [{ name: 'skill', description: 'custom', parameters: {}, execute: () => '' }]
      })
    ).issues
  ).toBeDefined()
})

test('동적 공급자의 도구와 스킬을 함께 실행하고 후속 요청에도 같은 목록을 전달한다', async (t) => {
  const externalCall: LLMEvent[] = [
    { type: EventType.TOOL_CALL_START, toolCallId: 'external', toolCallName: 'lookup' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: 'external', delta: '{}' },
    { type: EventType.TOOL_CALL_END, toolCallId: 'external' }
  ]
  const { ctx, requests } = await setup(t, [[...call('review'), ...externalCall], answer], undefined, async () => [
    { name: 'lookup', description: 'External lookup', parameters: {}, execute: () => 'External result' }
  ])
  ctx.skills.registerProvider(
    provider(async () => ({
      skills: [{ name: 'review', description: 'Review changes' }],
      async load(name) {
        return { name, description: 'Review changes', content: 'Check public behavior.' }
      }
    }))
  )
  const events = await collect(ctx.agent.run(input))
  expect(events.at(-1)?.type).toBe(EventType.RUN_FINISHED)
  expect(requests.map((request) => request.input.tools.map((tool) => tool.name))).toEqual([
    ['lookup', 'skill'],
    ['lookup', 'skill']
  ])
  expect(requests[1].input.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ role: 'tool', toolCallId: 'external', content: 'External result' }),
      expect.objectContaining({
        role: 'tool',
        toolCallId: 'load',
        content: '<skill_content name="review">\nCheck public behavior.\n</skill_content>'
      })
    ])
  )
})

test('동적 도구 공급자가 스킬 예약 이름을 반환하면 생성 전에 거부한다', async (t) => {
  const { ctx, requests } = await setup(t, [], undefined, async () => [
    { name: 'skill', description: 'External skill', parameters: {}, execute: () => 'Must not run' }
  ])
  await expect(collect(ctx.agent.run(input))).rejects.toThrow('skill tool name is reserved')
  expect(requests).toEqual([])
  expect(await ctx.generation.get('run')).toBeUndefined()
})
