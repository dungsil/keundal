import { fileURLToPath } from 'node:url'

import { EventType, SteerQueue, parseAGUIEvent, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import acpAgentPlugin, { type AcpAgentConfig } from '@keundal/plugin-agent-acp'
import { MemoryGenerationService, MemorySessionService, MemoryStore } from '@keundal/plugin-store-memory'
import { ToolApproval, TOOL_APPROVAL_EVENT, isToolApprovalRecord } from '@keundal/tool-approval'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const input = (text: string, threadId = 'thread'): RunAgentInput => ({
  threadId,
  runId: crypto.randomUUID(),
  state: {},
  tools: [],
  context: [],
  messages: [{ id: crypto.randomUUID(), role: 'user', content: text }]
})
const collect = async (stream: AsyncIterable<AGUIEvent>) => {
  const events: AGUIEvent[] = []
  for await (const event of stream) events.push(parseAGUIEvent(event))
  return events
}
const text = (events: AGUIEvent[]) =>
  events.flatMap((event) => (event.type === EventType.TEXT_MESSAGE_CONTENT ? [event.delta] : [])).join('')

async function setup(t: TestContext, config: Partial<AcpAgentConfig> = {}) {
  const ctx = new Context()
  const store = new MemoryStore()
  const root = await ctx.plugin((child: Context) => {
    new MemorySessionService(child, store)
    new MemoryGenerationService(child, store)
  })
  const agent = await ctx.plugin(acpAgentPlugin, {
    command: process.execPath,
    args: [fileURLToPath(new URL('./stdio.ts', import.meta.url))],
    cwd: process.cwd(),
    ...config
  })
  t.onTestFinished(async () => {
    await agent.dispose()
    await root.dispose()
  })
  return { ctx, agent }
}

test('stdio 세션은 새 사용자 메시지만 보내고 턴마다 식별자를 분리해 journal에 저장한다', async (t) => {
  const { ctx } = await setup(t)
  const first = input('first')
  first.messages = [
    {
      ...first.messages[0]!,
      role: 'user',
      content: [
        { type: 'text', text: 'fir' },
        { type: 'text', text: 'st' }
      ]
    }
  ]
  await ctx.session.commit({ threadId: first.threadId, expectedRevision: 0, messages: first.messages, state: {} })
  const events = await collect(ctx.agent.run(first))
  expect(text(events)).toBe(`1:first:${process.cwd()}!`)
  expect(events.filter((event) => event.type === EventType.TEXT_MESSAGE_START)).toHaveLength(2)
  const second = input('second')
  second.messages.unshift(...first.messages)
  const next = await collect(ctx.agent.run(second))
  expect(text(next)).toBe(`2:second:${process.cwd()}!`)
  expect(text(await collect(ctx.agent.run(input('isolated', 'other'))))).toBe(`1:isolated:${process.cwd()}!`)
  const snapshot = await ctx.session.get('thread')
  const tools = snapshot?.messages.filter((message) => message.role === 'tool')
  expect(tools).toHaveLength(2)
  expect(new Set(tools?.map((message) => message.toolCallId)).size).toBe(2)
  const calls = snapshot?.messages.flatMap((message) => (message.role === 'assistant' ? (message.toolCalls ?? []) : []))
  expect(calls?.map((call) => JSON.parse(call.function.arguments))).toEqual([{ value: 'new' }, { value: 'new' }])
  const saved = await ctx.generation.get(second.runId)
  expect(saved?.status).toBe('completed')
  expect(saved?.journal.at(-1)?.event.type).toBe(EventType.RUN_FINISHED)
})

test('실행 중 지시는 ACP 턴이 끝난 뒤 전달하고 같은 generation에 저장한다', async (t) => {
  const { ctx } = await setup(t)
  const steer = new SteerQueue()
  const events: AGUIEvent[] = []
  const request = input('original')
  const instruction = { id: 'steer', role: 'user' as const, content: 'steered' }
  let sent = false
  for await (const event of ctx.agent.run(request, { steer })) {
    events.push(parseAGUIEvent(event))
    if (!sent && event.type === EventType.TEXT_MESSAGE_CONTENT) {
      steer.push([instruction])
      sent = true
    }
  }
  expect(text(events)).toBe(`1:original:${process.cwd()}!2:steered:${process.cwd()}!`)
  expect(events.filter((event) => event.type === EventType.RUN_FINISHED)).toHaveLength(1)
  expect((await ctx.generation.get(request.runId))?.messages).toContainEqual(instruction)
})

test('권한 요청은 기본 거부하고 사용자 승인은 allow_once만 선택한다', async (t) => {
  const denied = await setup(t)
  expect(text(await collect(denied.ctx.agent.run(input('permission'))))).toBe(
    '{"outcome":"selected","optionId":"deny"}'
  )
  const approval = new ToolApproval({ default: 'ask' })
  const { ctx } = await setup(t, { toolApproval: approval })
  const request = input('permission')
  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run(request)) {
    events.push(event)
    if (
      event.type === EventType.CUSTOM &&
      event.name === TOOL_APPROVAL_EVENT &&
      isToolApprovalRecord(event.value) &&
      event.value.status === 'requested'
    ) {
      const toolCallId = event.value.toolCallId
      expect(events.some((item) => item.type === EventType.TOOL_CALL_START && item.toolCallId === toolCallId)).toBe(
        true
      )
      expect(approval.respond('wrong-run', event.value.requestId, 'allow')).toBe(false)
      expect(approval.respond(request.runId, event.value.requestId, 'allow')).toBe(true)
    }
  }
  expect(text(events)).toBe('{"outcome":"selected","optionId":"yes"}')
})

test('취소와 iterator 중단은 외부 프로세스를 끝내고 journal의 부분 응답을 보존한다', async (t) => {
  const { ctx } = await setup(t)
  const request = input('wait')
  const abort = new AbortController()
  await expect(
    (async () => {
      for await (const event of ctx.agent.run(request, { signal: abort.signal })) {
        if (event.type === EventType.TEXT_MESSAGE_CONTENT) abort.abort()
      }
    })()
  ).rejects.toThrow()
  const saved = await ctx.generation.get(request.runId)
  expect(saved?.status).toBe('cancelled')
  expect(saved?.messages.some((message) => message.role === 'assistant' && message.content?.includes('1:wait:'))).toBe(
    true
  )
  await expect(collect(ctx.agent.run(input('next')))).rejects.toThrow('session is closed')
  const stopped = input('wait', 'iterator')
  for await (const event of ctx.agent.run(stopped)) {
    if (event.type === EventType.TEXT_MESSAGE_CONTENT) break
  }
  expect((await ctx.generation.get(stopped.runId))?.status).toBe('cancelled')
})

for (const mode of ['error', 'crash']) {
  test(`외부 오류 ${mode}는 성공으로 기록하거나 자동 재실행하지 않는다`, async (t) => {
    const { ctx } = await setup(t)
    const request = input(mode)
    await expect(collect(ctx.agent.run(request))).rejects.toThrow()
    const saved = await ctx.generation.get(request.runId)
    expect(saved?.journal.some(({ event }) => event.type === EventType.RUN_FINISHED)).toBe(false)
    expect(saved?.status).toBe('failed')
  })
}

test('프로토콜 버전이 다르면 실행을 실패로 기록한다', async (t) => {
  const { ctx } = await setup(t, { env: { BAD_VERSION: '1' } })
  const request = input('hello')
  await expect(collect(ctx.agent.run(request))).rejects.toThrow('unsupported ACP protocol version')
  expect((await ctx.generation.get(request.runId))?.status).toBe('failed')
})

test('동일 대화의 동시 실행과 이전 메시지 수정 및 복원 불가능한 세션을 거부한다', async (t) => {
  const { ctx, agent } = await setup(t)
  const request = input('wait')
  const stream = ctx.agent.run(request)
  await stream.next()
  await expect(collect(ctx.agent.run(input('other')))).rejects.toThrow('active run')
  await stream.return?.()
  const first = input('first', 'editable')
  await collect(ctx.agent.run(first))
  const edited = input('new', 'editable')
  edited.messages.unshift({ ...first.messages[0]!, content: 'changed', role: 'user' })
  await expect(collect(ctx.agent.run(edited))).rejects.toThrow('cannot edit')
  await agent.dispose()
  await ctx.plugin(acpAgentPlugin, { command: process.execPath, cwd: process.cwd() })
  await expect(collect(ctx.agent.run(input('after restart', 'editable')))).rejects.toThrow('cannot be restored')
})
