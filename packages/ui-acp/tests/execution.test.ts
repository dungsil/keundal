import type { PlanEntry, SessionNotification, ToolCallContent } from '@agentclientprotocol/sdk'
import { EventType, type AGUIEvent } from '@keundal/core'
import type { GenerationSnapshot } from '@keundal/generation'
import { expect, test } from 'vitest'
import { applyExecutionEvent, createExecution, type AcpExecution, type AcpTool } from '../app/lib/execution.js'
import { applyLiveExecutionEvent, createLiveExecution, restoreExecution } from '../app/lib/live-execution.js'

function custom(value: unknown): AGUIEvent {
  return { type: EventType.CUSTOM, name: 'keundal.acp.update', value }
}

function update(payload: SessionNotification['update'], sessionId = 'acp-session'): AGUIEvent {
  return custom({ sessionId, update: payload } satisfies SessionNotification)
}

function replay(events: AGUIEvent[]): AcpExecution {
  const state = createExecution()
  for (const event of events) applyExecutionEvent(state, event)
  return state
}

const plan: PlanEntry[] = [{ content: '파일 수정', priority: 'high', status: 'in_progress' }]
const diff: ToolCallContent = { type: 'diff', path: '/project/a.ts', oldText: null, newText: 'hello' }
const start: AGUIEvent = { type: EventType.TOOL_CALL_START, toolCallId: 'agui-1', toolCallName: 'edit' }
const finish: AGUIEvent = { type: EventType.RUN_FINISHED, threadId: 'thread', runId: 'run' }

test('새 실행은 실행 중이며 계획과 도구를 다른 실행과 공유하지 않는다', () => {
  const first = createExecution()
  const second = createExecution()
  expect(first).toEqual({ plan: [], tools: new Map(), status: 'running' })
  expect(first.plan).not.toBe(second.plan)
  expect(first.tools).not.toBe(second.tools)
})

test('실시간 순차 투영과 영속 이벤트 전체 재생은 모든 접두 구간에서 같다', () => {
  const events: AGUIEvent[] = [
    { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '수정합니다' } }),
    { type: EventType.TEXT_MESSAGE_START, messageId: 'message', role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'message', delta: '수정합니다' },
    update({ sessionUpdate: 'plan', entries: plan }),
    update({ sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: '파일 수정', status: 'pending' }),
    { type: EventType.TEXT_MESSAGE_END, messageId: 'message' },
    start,
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'in_progress', content: [diff] }),
    update({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 0.2, currency: 'USD' } }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'completed', rawOutput: { ok: true } }),
    { type: EventType.TOOL_CALL_END, toolCallId: 'agui-1' },
    { type: EventType.TOOL_CALL_RESULT, toolCallId: 'agui-1', messageId: 'result', role: 'tool', content: 'ok' },
    update({ sessionUpdate: 'usage_update', used: 120, size: 1000 }),
    finish
  ]
  const live = createExecution()
  const persisted: AGUIEvent[] = JSON.parse(JSON.stringify(events))
  events.forEach((event, index) => {
    applyExecutionEvent(live, event)
    expect(live).toEqual(replay(persisted.slice(0, index + 1)))
  })
  expect(live.status).toBe('completed')
  expect(live.plan).toEqual(plan)
  expect(live.tools.get('acp-1')).toMatchObject({ aguiToolCallId: 'agui-1', status: 'completed', content: [diff] })
})

test('계획은 누적하지 않고 빈 목록을 포함한 새 스냅숏으로 교체한다', () => {
  const state = replay([update({ sessionUpdate: 'plan', entries: plan })])
  const next: PlanEntry[] = [{ content: '검사', priority: 'low', status: 'pending', _meta: null }]
  applyExecutionEvent(state, update({ sessionUpdate: 'plan', entries: next }))
  expect(state.plan).toEqual(next)
  applyExecutionEvent(state, update({ sessionUpdate: 'plan', entries: [] }))
  expect(state.plan).toEqual([])
})

test('도구 부분 갱신에서 생략과 null은 기존 필드를 보존하고 명시한 값만 바꾼다', () => {
  const state = replay([
    update({
      sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: '파일 수정', name: 'edit', kind: 'edit',
      status: 'in_progress', content: [diff], locations: [{ path: '/project/a.ts', line: null }],
      rawInput: { path: '/project/a.ts' }, rawOutput: { progress: 1 }, _meta: { source: 'agent' }
    }),
    start
  ])
  const before = structuredClone(state.tools.get('acp-1'))
  applyExecutionEvent(state, update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-1' }))
  expect(state.tools.get('acp-1')).toEqual(before)
  applyExecutionEvent(state, update({
    sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', title: null, name: null, kind: null,
    status: null, content: null, locations: null, rawInput: null, rawOutput: null, _meta: null
  }))
  expect(state.tools.get('acp-1')).toEqual(before)
  applyExecutionEvent(state, update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'failed' }))
  expect(state.tools.get('acp-1')).toEqual({ ...before, status: 'failed' })
})

test('도구 content와 locations는 추가하지 않고 교체하며 빈 값은 이전 diff와 위치를 지운다', () => {
  const state = replay([update({
    sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: '수정', content: [diff],
    locations: [{ path: '/project/a.ts', line: 1 }]
  }), start])
  const content: ToolCallContent[] = [{ type: 'content', content: { type: 'text', text: '완료' } }]
  applyExecutionEvent(state, update({
    sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', content,
    locations: [{ path: '/project/b.ts', line: 0 }], title: '', name: '', rawInput: {}, rawOutput: false
  }))
  expect(state.tools.get('acp-1')).toMatchObject({
    content, locations: [{ path: '/project/b.ts', line: 0 }], title: '', name: '', rawInput: {}, rawOutput: false
  })
  applyExecutionEvent(state, update({
    sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', content: [], locations: [], rawInput: [], rawOutput: 0
  }))
  expect(state.tools.get('acp-1')).toMatchObject({ content: [], locations: [], rawInput: [], rawOutput: 0 })
})

test('SDK v1의 모든 도구 콘텐츠와 nullable 선택 필드를 보존한다', () => {
  const content: ToolCallContent[] = [
    diff,
    { type: 'terminal', terminalId: 'terminal', _meta: null },
    { type: 'content', content: { type: 'text', text: '', annotations: { audience: null, priority: null } } },
    { type: 'content', content: { type: 'image', data: 'AA==', mimeType: 'image/png', uri: null } },
    { type: 'content', content: { type: 'audio', data: 'AA==', mimeType: 'audio/wav', annotations: null } },
    { type: 'content', content: { type: 'resource_link', name: '파일', uri: 'file:///a', size: null, title: null } },
    { type: 'content', content: { type: 'resource', resource: { uri: 'file:///a', text: '내용', mimeType: null } } },
    { type: 'content', content: { type: 'resource', resource: { uri: 'file:///b', blob: 'AA==', _meta: null } } }
  ]
  const state = replay([update({ sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: '', content })])
  expect(state.tools.get('acp-1')?.content).toEqual(content)
})

test('같은 ACP 도구 ID를 재사용하는 다음 실행은 이전 내용이나 AG-UI 연결을 물려받지 않는다', () => {
  const first = replay([
    update({ sessionUpdate: 'tool_call', toolCallId: 'same-id', title: '이전 수정', content: [diff], status: 'completed' }),
    start, finish
  ])
  const second = replay([
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'same-id', status: 'pending' }),
    { ...start, toolCallId: 'agui-2' }
  ])
  const tool: AcpTool | undefined = second.tools.get('same-id')
  expect(tool).toEqual({ toolCallId: 'same-id', status: 'pending', aguiToolCallId: 'agui-2' })
  applyExecutionEvent(second, update({ sessionUpdate: 'tool_call_update', toolCallId: 'same-id', status: 'failed' }))
  expect(first.tools.get('same-id')).toMatchObject({ content: [diff], status: 'completed', aguiToolCallId: 'agui-1' })
})

test('사용량과 누적 비용은 더하지 않고 최신 스냅숏으로 바꾸며 빠진 비용도 제거한다', () => {
  const state = replay([
    update({ sessionUpdate: 'usage_update', used: 100, size: 1000, cost: { amount: 1, currency: 'USD' } }),
    update({ sessionUpdate: 'usage_update', used: 150, size: 2000, cost: { amount: 2, currency: 'USD' } })
  ])
  expect(state.usage).toEqual({ used: 150, size: 2000, cost: { amount: 2, currency: 'USD' } })
  applyExecutionEvent(state, update({ sessionUpdate: 'usage_update', used: 0, size: 2000, cost: null }))
  expect(state.usage).toEqual({ used: 0, size: 2000, cost: null })
  applyExecutionEvent(state, update({ sessionUpdate: 'usage_update', used: 10, size: 2000 }))
  expect(state.usage).toEqual({ used: 10, size: 2000 })
})

test('ACP 도구 다음의 AG-UI 시작만 연결하고 일반 도구 이벤트로 상태를 추정하지 않는다', () => {
  const state = replay([start])
  expect(state.tools.size).toBe(0)
  applyExecutionEvent(state, update({ sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: '수정' }))
  expect(state.pendingToolId).toBe('acp-1')
  applyExecutionEvent(state, { type: EventType.REASONING_MESSAGE_END, messageId: 'thought' })
  applyExecutionEvent(state, { type: EventType.REASONING_END, messageId: 'thought' })
  applyExecutionEvent(state, start)
  expect(state.pendingToolId).toBeUndefined()
  applyExecutionEvent(state, update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'in_progress' }))
  applyExecutionEvent(state, { ...start, toolCallId: 'ordinary-tool' })
  applyExecutionEvent(state, { type: EventType.TOOL_CALL_ARGS, toolCallId: 'agui-1', delta: '{}' })
  applyExecutionEvent(state, { type: EventType.TOOL_CALL_END, toolCallId: 'agui-1' })
  applyExecutionEvent(state, { type: EventType.TOOL_CALL_RESULT, toolCallId: 'agui-1', messageId: 'r', role: 'tool', content: 'ok' })
  expect(state.tools.get('acp-1')).toEqual({ toolCallId: 'acp-1', title: '수정', status: 'in_progress', aguiToolCallId: 'agui-1' })
  expect(state.tools.size).toBe(1)
  applyExecutionEvent(state, update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-2', title: '조회' }))
  applyExecutionEvent(state, { type: EventType.CUSTOM, name: 'ordinary', value: {} })
  applyExecutionEvent(state, { ...start, toolCallId: 'unrelated' })
  expect(state.tools.get('acp-2')?.aguiToolCallId).toBeUndefined()
})

test('정상 종료와 실패와 중단과 취소는 실행 상태만 바꾸며 미완료 도구와 계획을 완료하지 않는다', () => {
  const terminals: Array<{ event: AGUIEvent; status: AcpExecution['status'] }> = [
    { event: finish, status: 'completed' },
    { event: { type: EventType.RUN_ERROR, message: '연결 종료' }, status: 'failed' },
    { event: { ...finish, outcome: { type: 'interrupt', interrupts: [{ id: 'pause', reason: '승인 필요' }] } }, status: 'interrupted' },
    { event: { ...finish, outcome: { type: 'cancelled' } }, status: 'cancelled' }
  ]
  for (const { event, status } of terminals) {
    const state = replay([
      update({ sessionUpdate: 'plan', entries: plan }),
      update({ sessionUpdate: 'tool_call', toolCallId: 'acp-1', title: '수정', status: 'in_progress' }),
      start, event
    ])
    expect(state.status).toBe(status)
    expect(state.plan).toEqual(plan)
    expect(state.tools.get('acp-1')?.status).toBe('in_progress')
  }
  const recovered = replay([
    update({ sessionUpdate: 'plan', entries: plan }),
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', status: 'pending' })
  ])
  // Recovery supplies the persisted GenerationStatus without inventing events.
  recovered.status = 'interrupted'
  expect(recovered.plan).toEqual(plan)
  expect(recovered.tools.get('acp-1')?.status).toBe('pending')
})

test('실행 페이로드가 없는 ACP 텍스트와 추론 조각도 sessionId를 설정한다', () => {
  for (const sessionUpdate of ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk'] as const) {
    const state = replay([update({ sessionUpdate, content: { type: 'text', text: '' }, messageId: null }, 'text-session')])
    expect(state).toEqual({ ...createExecution(), sessionId: 'text-session' })
  }
})

test('알 수 없거나 잘못된 갱신은 예외나 잘못된 실행 데이터를 만들지 않는다', () => {
  const invalid: unknown[] = [
    undefined, null, [], 'invalid', {},
    { sessionId: 1, update: { sessionUpdate: 'plan', entries: [] } },
    { sessionId: 'other', update: null },
    ...[
      { sessionUpdate: 'future_update', entries: plan },
      { sessionUpdate: 'plan', entries: [{ ...plan[0], status: 'failed' }] },
      { sessionUpdate: 'plan', entries: null },
      { sessionUpdate: 'tool_call', toolCallId: 'bad' },
      { sessionUpdate: 'tool_call', toolCallId: 'bad', title: '도구', content: null },
      { sessionUpdate: 'tool_call_update', toolCallId: 1 },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bad', status: 'future' },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bad', content: [{ type: 'diff', path: '/a' }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bad', content: [{ type: 'content', content: { type: 'text', text: 1 } }] },
      { sessionUpdate: 'tool_call_update', toolCallId: 'bad', locations: [{ path: '/a', line: -1 }] },
      { sessionUpdate: 'usage_update', used: -1, size: 100 },
      { sessionUpdate: 'usage_update', used: 1.5, size: 100 },
      { sessionUpdate: 'usage_update', used: 1, size: 100, cost: { amount: 'bad', currency: 'USD' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 1 } }
    ].map((payload) => ({ sessionId: 'other', update: payload }))
  ]
  const state = replay([update({ sessionUpdate: 'plan', entries: plan })])
  const before = structuredClone(state)
  for (const value of invalid) {
    expect(() => applyExecutionEvent(state, custom(value))).not.toThrow()
    expect(state).toEqual(before)
  }
  const empty = replay(invalid.map(custom))
  expect(empty).toEqual(createExecution())
})

test('알 수 없는 필드는 도구의 AG-UI 연결을 덮어쓰지 못하고 잘못된 갱신 뒤 일반 시작도 연결하지 않는다', () => {
  const state = replay([custom({ sessionId: 'session', update: {
    sessionUpdate: 'tool_call_update', toolCallId: 'acp-1', aguiToolCallId: 'forged', title: '조회', future: true
  } })])
  expect(state.tools.get('acp-1')).toEqual({ toolCallId: 'acp-1', title: '조회' })
  applyExecutionEvent(state, custom({ sessionId: 'session', update: { sessionUpdate: 'unknown' } }))
  applyExecutionEvent(state, start)
  expect(state.tools.get('acp-1')?.aguiToolCallId).toBeUndefined()
})

test('저장이 늦은 journal을 읽어도 먼저 받은 실시간 계획과 도구를 잃지 않고 종료 상태는 영속 기록을 따른다', () => {
  const live = createLiveExecution()
  const events: AGUIEvent[] = [
    { type: EventType.RUN_STARTED, threadId: 'thread', runId: 'run' },
    update({ sessionUpdate: 'plan', entries: plan }),
    update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: '수정', status: 'in_progress' }),
    start,
    update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [diff] }),
    update({ sessionUpdate: 'plan', entries: [{ ...plan[0]!, status: 'completed' }] }),
    update({ sessionUpdate: 'tool_call', toolCallId: 'test', title: '검사', status: 'in_progress' }),
    { ...start, toolCallId: 'agui-test' }
  ]
  for (const event of events) applyLiveExecutionEvent(live, event)
  const snapshot = {
    status: 'running',
    journal: events.slice(0, 3).map((event, sequence) => ({ sequence, event }))
  } as GenerationSnapshot
  restoreExecution(live, 'run', snapshot)
  const state = live.runs.get('run')!
  expect(state.plan[0]?.status).toBe('completed')
  expect([...state.tools.keys()]).toEqual(['edit', 'test'])
  expect(state.tools.get('edit')).toMatchObject({ status: 'completed', content: [diff], aguiToolCallId: 'agui-1' })
  expect(state.tools.get('test')).toMatchObject({ status: 'in_progress', aguiToolCallId: 'agui-test' })
  const delayedStream = createLiveExecution()
  for (const event of events.slice(0, 3)) applyLiveExecutionEvent(delayedStream, event)
  restoreExecution(delayedStream, 'run', {
    ...snapshot, journal: events.map((event, sequence) => ({ sequence, event }))
  })
  expect(delayedStream.runs.get('run')).toEqual(state)
  restoreExecution(live, 'run', {
    ...snapshot, status: 'interrupted', journal: events.map((event, sequence) => ({ sequence, event }))
  })
  expect(live.runs.get('run')?.status).toBe('interrupted')
  expect(live.runs.get('run')?.tools.get('test')?.status).toBe('in_progress')
  expect(live.events.has('run')).toBe(false)
})
