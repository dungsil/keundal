import type { TraceSpan } from '@keundal/core'
import { expect, test } from 'vitest'
import { flattenTraceSpans, reconcileTraceSpans, traceTimelineBounds, traceUsageCompleteness, traceRunDuration } from '../app/lib/trace'

function span(spanId: string, parentSpanId?: string, sequence = 0): TraceSpan {
  return {
    version: 1,
    traceId: 'trace',
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    runId: 'run',
    kind: 'agent',
    name: spanId,
    sequence,
    startedAt: sequence,
    status: 'completed'
  }
}

test('단계 트리는 부모 관계와 시작 순서를 유지하고 표시 개수를 제한한다', () => {
  const rows = flattenTraceSpans([
    span('root'),
    span('model', 'root', 1),
    span('tool', 'root', 2),
    span('child', 'model', 3)
  ], 3)

  expect(rows.map(row => [row.span.spanId, row.depth])).toEqual([
    ['root', 0],
    ['model', 1],
    ['child', 2]
  ])
})

test('부모가 없는 단계는 최상위에 표시하고 요청한 개수로 제한한다', () => {
  const rows = flattenTraceSpans([
    span('orphan', 'missing'),
    span('root'),
    span('child', 'root')
  ], 2)

  expect(rows.map(row => [row.span.spanId, row.depth])).toEqual([
    ['orphan', 0],
    ['root', 0]
  ])
})

test('취소와 복구로 종료한 실행은 남은 실행 중 단계의 상태를 바꾼다', () => {
  const active = { ...span('active'), status: 'running' as const }
  const completed = { ...span('completed'), status: 'completed' as const }

  expect(reconcileTraceSpans([active, completed], 'interrupted').map(item => item.status)).toEqual(['interrupted', 'completed'])
  expect(reconcileTraceSpans([active], 'cancelled')[0]?.status).toBe('cancelled')
})

test('타임라인은 병렬 작업 시간을 중복으로 더하지 않고 실행 중 작업의 현재 시각을 사용한다', () => {
  expect(traceTimelineBounds([
    { ...span('first'), startedAt: 100, endedAt: 300 },
    { ...span('parallel'), startedAt: 200, endedAt: 500 },
    { ...span('active'), startedAt: 400, status: 'running' }
  ], 600)).toEqual({ start: 100, end: 600 })
  expect(traceTimelineBounds([{ ...span('interrupted'), startedAt: 100, status: 'interrupted' }], 900)).toEqual({ start: 100, end: 100 })
})

test('모델마다 누락된 토큰 필드는 부분 집계로 구분한다', () => {
  const models: TraceSpan[] = [
    { ...span('first'), kind: 'model', usage: { source: 'provider', inputTokens: 10, outputTokens: 4, cacheReadTokens: 0 } },
    { ...span('second'), kind: 'model', usage: { source: 'provider', inputTokens: 20 } }
  ]
  expect(traceUsageCompleteness(models)).toEqual({ inputTokens: true, outputTokens: false, cacheReadTokens: false, cacheWriteTokens: false })
  expect(traceUsageCompleteness([...models, { ...span('unknown'), kind: 'model' }]).inputTokens).toBe(false)
})

test('루트 종료 시각을 모르는 중단 실행은 전체 소요 시간을 확정하지 않는다', () => {
  const root = { ...span('root'), startedAt: 100, status: 'running' as const }
  const model: TraceSpan = { ...span('model', 'root'), kind: 'model', startedAt: 200, endedAt: 300 }
  expect(traceRunDuration([root, model], 'interrupted', 900)).toBeUndefined()
  expect(traceRunDuration([root, model], 'running', 900)).toBe(800)
  expect(traceRunDuration([{ ...root, endedAt: 1000, status: 'completed' }, model], 'completed', 2000)).toBe(900)
})
