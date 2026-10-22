import type { GenerationStatus, TraceSpan } from '@keundal/core'
import { expect, test } from 'vitest'
import { flattenTraceSpans, reconcileTraceSpans, traceDisplayStatus, traceRunDuration, traceTimelineBounds } from '../app/utils/trace'

function span(
  spanId: string,
  runId: string,
  kind: TraceSpan['kind'],
  sequence: number,
  parentSpanId?: string,
  extra: Partial<TraceSpan> = {}
): TraceSpan {
  return {
    version: 1,
    traceId: 'shared-trace',
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    runId,
    kind,
    name: spanId,
    sequence,
    startedAt: sequence * 10,
    status: 'completed',
    ...extra
  }
}

test('중첩 단계는 부모 관계 아래에서 실행별 시작 순서를 유지한다', () => {
  const rows = flattenTraceSpans([
    span('parent-root', 'parent-run', 'agent', 0),
    span('parent-tool', 'parent-run', 'tool', 2, 'parent-root'),
    span('child-root', 'child-run', 'agent', 0, 'parent-tool'),
    span('child-model', 'child-run', 'model', 1, 'child-root')
  ], 10)

  expect(rows.map(row => [row.span.spanId, row.depth])).toEqual([
    ['parent-root', 0],
    ['parent-tool', 1],
    ['child-root', 2],
    ['child-model', 3]
  ])
})

test('부모 종료 상태는 부모 루트만 정정하고 분리한 작업은 미확정으로 표시한다', () => {
  const root = span('parent-root', 'parent-run', 'agent', 0, undefined, { status: 'completed', endedAt: 20 })
  const tool = span('parent-tool', 'parent-run', 'tool', 1, 'parent-root')
  const childRoot = span('child-root', 'child-run', 'agent', 0, 'parent-tool')
  const detached = span('detached-model', 'child-run', 'model', 1, 'child-root', { status: 'running', detached: true })
  const spans = reconcileTraceSpans([root, tool, childRoot, detached], 'failed', 'parent-run')

  expect(spans.map(item => item.status)).toEqual(['failed', 'completed', 'completed', 'running'])
  expect(traceDisplayStatus(spans[3]!, 'failed')).toBe('unknown')
  expect(traceTimelineBounds([spans[3]!], 999, 'failed')).toEqual({ start: 10, end: 10 })
})

test('실행 시간은 자식이 아니라 요청한 실행의 루트를 기준으로 계산한다', () => {
  const parent = span('parent-root', 'parent-run', 'agent', 0, undefined, { startedAt: 100, endedAt: 500 })
  const child = span('child-root', 'child-run', 'agent', 0, 'parent-tool', { startedAt: 200, endedAt: 900 })
  const status: GenerationStatus = 'completed'
  expect(traceRunDuration([parent, child], status, 1000, 'parent-run')).toBe(400)
})
