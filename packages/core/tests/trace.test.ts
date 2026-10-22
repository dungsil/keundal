import { EventType } from '@ag-ui/core'
import { expect, test } from 'vitest'

import { readTraceSpans, summarizeTrace, TRACE_EVENT, type TraceSpan } from '../src/trace.js'

function event(span: TraceSpan) {
  return { type: EventType.CUSTOM, name: TRACE_EVENT, value: { version: 1, span } } as const
}

const root: TraceSpan = {
  version: 1,
  traceId: 'trace',
  spanId: 'root',
  runId: 'run',
  kind: 'agent',
  name: 'agent',
  sequence: 0,
  startedAt: 100,
  endedAt: 180,
  status: 'completed'
}
const model: TraceSpan = {
  version: 1,
  traceId: 'trace',
  spanId: 'model',
  parentSpanId: 'root',
  runId: 'run',
  kind: 'model',
  name: 'generate',
  sequence: 1,
  startedAt: 110,
  endedAt: 150,
  status: 'completed',
  usage: { source: 'provider', inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 },
  ttftMs: 7
}

test('도구가 모델의 하위 단계여도 모델 사용량을 유지하고 루트 시간을 한 번만 집계한다', () => {
  const latestModel = {
    ...model,
    endedAt: 160,
    usage: { source: 'provider' as const, inputTokens: 11, outputTokens: 5, cacheReadTokens: 3 }
  }
  const tool: TraceSpan = {
    ...model,
    spanId: 'tool',
    parentSpanId: model.spanId,
    kind: 'tool',
    name: 'lookup',
    sequence: 2,
    startedAt: 120,
    endedAt: 170,
    usage: undefined
  }
  const parallelModel: TraceSpan = {
    ...model,
    spanId: 'model-parallel',
    sequence: 3,
    startedAt: 115,
    endedAt: 145,
    usage: { source: 'provider', inputTokens: 2, outputTokens: 3 }
  }
  const events = [event(root), event(model), event(latestModel)]
  const spans = readTraceSpans(events, 'run')
  expect(spans.map((span) => span.sequence)).toEqual([0, 1])
  expect(spans.find((span) => span.spanId === 'model')?.endedAt).toBe(160)
  expect(readTraceSpans(events, 'other')).toEqual([])
  expect(summarizeTrace([root, model, latestModel, tool, parallelModel])).toEqual({
    inputTokens: 13,
    outputTokens: 8,
    cacheReadTokens: 3,
    usageSource: 'provider',
    durationMs: 80
  })
})

test('알려진 토큰 수를 보존하고 알 수 없는 비용은 생략한다', () => {
  const partial = { ...model, usage: { source: 'provider' as const, inputTokens: 8 } }
  expect(summarizeTrace([partial])).toEqual({ inputTokens: 8, usageSource: 'provider' })
  expect(summarizeTrace([{ ...root, endedAt: undefined, status: 'running' }, model])).toEqual({
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    usageSource: 'provider'
  })
  expect(summarizeTrace([{ ...model, usage: undefined }])).toEqual({ usageSource: 'unknown' })
})

test('명시한 비용만 합산하고 비용을 모르는 호출이 있으면 부분 집계로 표시한다', () => {
  const priced = { ...model, cost: { currency: 'USD', amount: 0.01, source: 'provider' as const } }
  expect(summarizeTrace([priced]).cost).toEqual({ currency: 'USD', amount: 0.01, complete: true, source: 'provider' })
  expect(summarizeTrace([priced, { ...model, spanId: 'unpriced', sequence: 2 }]).cost).toEqual({
    currency: 'USD',
    amount: 0.01,
    complete: false,
    source: 'provider'
  })
  expect(summarizeTrace([{ ...priced, status: 'running', endedAt: undefined, detached: true }]).cost).toEqual({
    currency: 'USD',
    amount: 0.01,
    complete: false,
    source: 'provider'
  })
})

test('정제하지 않은 오류 문자열이 있는 저장 Span을 거부한다', () => {
  const unsafe = { ...model, error: 'provider response included secret-token' } as unknown as TraceSpan
  expect(readTraceSpans([event(unsafe)])).toEqual([])
})

test('지원하는 버전의 Span을 검사하고 보관 개수를 제한한다', () => {
  expect(
    readTraceSpans(
      [
        event(root),
        event(model),
        { type: EventType.CUSTOM, name: TRACE_EVENT, value: { version: 2, span: root } } as never
      ],
      undefined,
      1
    )
  ).toEqual([model])
})

test('상위 실행과 Compaction의 요약 사용량과 비용은 모델 집계에 다시 더하지 않는다', () => {
  const aggregate = {
    source: 'provider' as const,
    inputTokens: 1000,
    outputTokens: 500,
    cacheReadTokens: 400,
    cacheWriteTokens: 200
  }
  const containerCost = { currency: 'USD', amount: 100, source: 'provider' as const }
  const summary: TraceSpan = {
    ...root,
    spanId: 'compact',
    parentSpanId: root.spanId,
    kind: 'compaction',
    usage: aggregate,
    cost: containerCost
  }
  const pricedModel: TraceSpan = {
    ...model,
    parentSpanId: summary.spanId,
    usage: { source: 'provider', inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 },
    cost: { currency: 'USD', amount: 0.01, source: 'provider' }
  }
  const total = summarizeTrace([{ ...root, usage: aggregate, cost: containerCost }, summary, pricedModel, pricedModel])
  expect(total).toMatchObject({
    inputTokens: 10,
    outputTokens: 4,
    cacheReadTokens: 2,
    cacheWriteTokens: 1,
    cost: { currency: 'USD', amount: 0.01, complete: true }
  })
})
