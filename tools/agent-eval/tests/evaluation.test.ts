import { EventType, type AGUIEvent } from '@keundal/core'
import { expect, test } from 'vitest'

import demo from '../configs/demo.ts'
import {
  compareEvaluations,
  evaluate,
  summarizeEvaluation,
  type EvaluationCandidate,
  type EvaluationScenario
} from '../src/index.ts'

test('코딩 에이전트의 반복 실행을 독립 채점하고 모델별 성공률과 사용량 및 비용을 집계한다', async () => {
  const report = await evaluate(demo, { repetitions: 2 })
  const [broken, correct] = summarizeEvaluation(report)
  expect(report.results).toHaveLength(8)
  expect(broken).toMatchObject({ attempts: 4, successRate: 0, toolCalls: 4, inputTokens: 800, outputTokens: 160 })
  expect(correct).toMatchObject({ attempts: 4, successRate: 1, toolCalls: 4, inputTokens: 800, outputTokens: 400 })
  expect(broken.cost?.amount).toBeCloseTo(0.00112, 10)
  expect(correct.cost).toEqual({ currency: 'USD', amount: 0.0024 })
  expect(report.results.every((result) => result.durationMs > 0)).toBe(true)

  const changed = {
    ...report,
    results: report.results.map((result) => ({
      ...result,
      status: 'passed' as const,
      trace: {
        ...result.trace,
        cost: { currency: 'USD', amount: 0.001, complete: true, source: 'estimate' as const }
      }
    }))
  }
  const deltas = compareEvaluations(report, changed)
  expect(deltas[0].successRateDelta).toBe(1)
  expect(deltas[0].costDelta?.amount).toBeCloseTo(0.00288, 10)
  expect(deltas[1].successRateDelta).toBe(0)
  expect(deltas[1].costDelta?.amount).toBeCloseTo(0.0016, 10)
  expect(() => compareEvaluations(report, { ...changed, scenarios: [{ id: 'coding-slug', version: '2' }] })).toThrow(
    'identical'
  )
  expect(() => compareEvaluations(report, { ...changed, repetitions: 3 })).toThrow('identical')
  expect(() => compareEvaluations(report, { ...changed, results: changed.results.slice(1) })).toThrow('matrix')
  expect(() =>
    compareEvaluations(report, { ...changed, results: changed.results.map(() => changed.results[0]) })
  ).toThrow('matrix')
  const missing = {
    ...report,
    results: report.results.map((result, index) =>
      index === 0 ? { ...result, trace: { usageSource: 'unknown' as const } } : result
    )
  }
  expect(summarizeEvaluation(missing)[0]).toMatchObject({ inputTokens: null, outputTokens: null, cost: null })
  expect(compareEvaluations(report, missing)[0].costDelta).toBeNull()
})

const scenario: EvaluationScenario = {
  id: 'control',
  version: '1',
  async prepare() {
    return { prompt: 'complete', tools: [], verify: async () => true, dispose: async () => {} }
  }
}

function candidate(id: string, stream: (signal?: AbortSignal) => AsyncGenerator<AGUIEvent>): EvaluationCandidate {
  return {
    id,
    model: id,
    revision: '1',
    async create() {
      return { agent: { run: (_input, options) => stream(options?.signal) }, dispose: async () => {} }
    }
  }
}

test('예외와 RUN_ERROR 및 종료 이벤트 누락을 실패로 기록하고 다음 후보를 계속 평가한다', async () => {
  const report = await evaluate({
    scenarios: [scenario],
    candidates: [
      candidate('throws', async function* () {
        yield { type: EventType.RUN_STARTED, threadId: 't', runId: 'r' }
        throw new Error('provider failed')
      }),
      candidate('eof', async function* () {
        yield* []
      }),
      candidate('error-event', async function* () {
        yield { type: EventType.RUN_ERROR, message: 'failure' }
        yield { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' }
      }),
      candidate('ok', async function* () {
        yield { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' }
      })
    ]
  })
  expect(report.results.map((result) => result.status)).toEqual(['error', 'error', 'error', 'passed'])
  expect(summarizeEvaluation(report)[3]).toMatchObject({
    successRate: 1,
    inputTokens: null,
    outputTokens: null,
    cost: null
  })
})

test('시간제한이 지나면 취소 신호를 전달하고 성공으로 채점하지 않는다', async () => {
  let cancelled = false
  const report = await evaluate(
    {
      scenarios: [scenario],
      candidates: [
        candidate('slow', async function* (signal) {
          await new Promise<void>((resolve) =>
            signal!.addEventListener(
              'abort',
              () => {
                cancelled = true
                resolve()
              },
              { once: true }
            )
          )
          yield { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' }
        })
      ]
    },
    { timeoutMs: 10 }
  )
  expect(report.results[0].status).toBe('timeout')
  expect(cancelled).toBe(true)
})

test('준비와 정리 오류를 기록하고 중복 식별자 및 잘못된 반복 횟수를 거부한다', async () => {
  const ok = candidate('ok', async function* () {
    yield { type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' }
  })
  const config = { scenarios: [scenario], candidates: [ok] }
  await expect(evaluate(config, { repetitions: 0 })).rejects.toThrow('positive integer')
  await expect(evaluate({ ...config, candidates: [ok, ok] })).rejects.toThrow('unique')
  const setupError = await evaluate({
    ...config,
    scenarios: [
      {
        ...scenario,
        async prepare() {
          throw new Error('setup')
        }
      }
    ]
  })
  expect(setupError.results[0]).toMatchObject({ status: 'error', error: 'setup' })
  const cleanupError = await evaluate({
    ...config,
    scenarios: [
      {
        ...scenario,
        async prepare() {
          return {
            ...(await scenario.prepare()),
            async dispose() {
              throw new Error('cleanup')
            }
          }
        }
      }
    ]
  })
  expect(cleanupError.results[0].status).toBe('error')
})
