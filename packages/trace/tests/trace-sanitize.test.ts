import { EventType } from '@keundal/core'
import type { AGUIEvent } from '@keundal/core'
import { readTraceSpans, TRACE_EVENT } from '@keundal/trace'
import { expect, test } from 'vitest'

test('Span과 사용량 및 비용에서 허용한 필드만 반환한다', () => {
  const event = {
    type: EventType.CUSTOM,
    name: TRACE_EVENT,
    value: {
      version: 1,
      privateEventField: 'private event body',
      span: {
        version: 1,
        traceId: 'trace',
        spanId: 'span',
        runId: 'run',
        kind: 'model',
        name: 'generate',
        sequence: 0,
        startedAt: 1,
        status: 'completed',
        model: 'test',
        detached: true,
        privateSpanField: 'private args',
        usage: {
          source: 'provider',
          inputTokens: 3,
          privateUsageField: 'private result'
        },
        cost: {
          currency: 'USD',
          amount: 0.1,
          source: 'provider',
          privateCostField: 'private key'
        }
      }
    }
  } as unknown as AGUIEvent

  const [span] = readTraceSpans([event], 'run')
  expect(span).toMatchObject({
    spanId: 'span',
    detached: true,
    usage: { source: 'provider', inputTokens: 3 },
    cost: { currency: 'USD', amount: 0.1, source: 'provider' }
  })
  expect(span).not.toHaveProperty('privateSpanField')
  expect(span?.usage).not.toHaveProperty('privateUsageField')
  expect(span?.cost).not.toHaveProperty('privateCostField')
  expect(Object.keys(span!)).not.toContain('privateEventField')
  expect(
    readTraceSpans([
      {
        type: EventType.CUSTOM,
        name: TRACE_EVENT,
        value: { version: 1, span: { ...span, model: { authorization: 'private header' } } }
      } as unknown as AGUIEvent
    ])
  ).toEqual([])
})
