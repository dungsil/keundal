import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { clearTimeout, setTimeout } from 'node:timers'

import type { AgentService } from '@keundal/agent'
import { EventType } from '@keundal/core'
import type { ExecutableTool } from '@keundal/tools'
import { readTraceSpans, summarizeTrace, type TraceSpan, type TraceSummary } from '@keundal/trace'

export interface EvaluationScenario {
  readonly id: string
  readonly version: string
  prepare(): Promise<{
    prompt: string
    tools: readonly ExecutableTool[]
    verify(): Promise<boolean>
    dispose(): Promise<void>
  }>
}

export interface EvaluationCandidate {
  readonly id: string
  readonly model: string
  /** Prompt/configuration revision or a content hash, saved with every report. */
  readonly revision: string
  create(tools: readonly ExecutableTool[]): Promise<{
    agent: Pick<AgentService, 'run'>
    dispose(): Promise<void>
  }>
}

export interface EvaluationConfig {
  readonly scenarios: readonly EvaluationScenario[]
  readonly candidates: readonly EvaluationCandidate[]
}

export interface EvaluationResult {
  readonly candidateId: string
  readonly scenarioId: string
  readonly attempt: number
  readonly status: 'passed' | 'failed' | 'error' | 'timeout'
  readonly error?: string
  readonly durationMs: number
  readonly toolCalls: number
  readonly trace: TraceSummary
}

export interface EvaluationReport {
  readonly version: 1
  readonly createdAt: string
  readonly repetitions: number
  readonly timeoutMs: number
  readonly scenarios: readonly { id: string; version: string }[]
  readonly candidates: readonly { id: string; model: string; revision: string }[]
  readonly results: readonly EvaluationResult[]
}

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
    throw new Error(`${label} must be a positive integer <= 2147483647`)
  }
}

export async function evaluate(
  config: EvaluationConfig,
  { repetitions = 1, timeoutMs = 60_000 } = {}
): Promise<EvaluationReport> {
  positiveInteger(repetitions, 'repetitions')
  positiveInteger(timeoutMs, 'timeoutMs')
  for (const entries of [config.scenarios, config.candidates]) {
    if (
      !entries.length ||
      entries.some((entry) => !entry.id.trim()) ||
      new Set(entries.map((entry) => entry.id)).size !== entries.length
    ) {
      throw new Error('Scenarios and candidates require unique, non-empty IDs')
    }
  }
  if (
    config.scenarios.some((scenario) => !scenario.version.trim()) ||
    config.candidates.some((candidate) => !candidate.model.trim() || !candidate.revision.trim())
  ) {
    throw new Error('Scenario versions, models and candidate revisions are required')
  }
  const results: EvaluationResult[] = []
  for (const scenario of config.scenarios) {
    for (let attempt = 1; attempt <= repetitions; attempt++) {
      for (const candidate of config.candidates) {
        const spans = new Map<string, TraceSpan>()
        const calls = new Set<string>()
        let prepared: Awaited<ReturnType<EvaluationScenario['prepare']>> | undefined
        let instance: Awaited<ReturnType<EvaluationCandidate['create']>> | undefined
        let status: EvaluationResult['status'] = 'error'
        let error: string | undefined
        let started = performance.now()
        let durationMs = 0
        const controller = new globalThis.AbortController()
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          prepared = await scenario.prepare()
          instance = await candidate.create(prepared.tools)
          started = performance.now()
          const aborted = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error('Evaluation deadline exceeded'))
            }, timeoutMs)
          })
          const execute = async () => {
            const runId = randomUUID()
            let finished = false
            let failed = false
            for await (const event of instance!.agent.run(
              {
                threadId: randomUUID(),
                runId,
                state: {},
                context: [],
                tools: [],
                messages: [{ id: randomUUID(), role: 'user', content: prepared!.prompt }]
              },
              { signal: controller.signal }
            )) {
              for (const span of readTraceSpans([event])) spans.set(span.spanId, span)
              if (event.type === EventType.TOOL_CALL_START) calls.add(event.toolCallId)
              if (event.type === EventType.RUN_FINISHED) finished = true
              if (event.type === EventType.RUN_ERROR) failed = true
            }
            durationMs = performance.now() - started
            controller.signal.throwIfAborted()
            if (failed || !finished) throw new Error('Agent did not finish successfully')
            return await prepared!.verify()
          }
          status = (await Promise.race([execute(), aborted])) ? 'passed' : 'failed'
        } catch (cause) {
          status = controller.signal.aborted ? 'timeout' : 'error'
          error = cause instanceof Error ? cause.message : String(cause)
        } finally {
          if (timer) clearTimeout(timer)
          if (!durationMs) durationMs = performance.now() - started
          controller.abort()
          try {
            await instance?.dispose()
          } catch (cause) {
            status = 'error'
            error = `Agent cleanup failed: ${String(cause)}`
          } finally {
            try {
              await prepared?.dispose()
            } catch (cause) {
              status = 'error'
              error = `Scenario cleanup failed: ${String(cause)}`
            }
          }
        }
        results.push({
          candidateId: candidate.id,
          scenarioId: scenario.id,
          attempt,
          status,
          ...(error === undefined ? {} : { error }),
          durationMs,
          toolCalls: calls.size,
          trace: summarizeTrace([...spans.values()])
        })
      }
    }
  }
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    repetitions,
    timeoutMs,
    scenarios: config.scenarios.map(({ id, version }) => ({ id, version })),
    candidates: config.candidates.map(({ id, model, revision }) => ({ id, model, revision })),
    results
  }
}

export function summarizeEvaluation(report: EvaluationReport) {
  return report.candidates.map((candidate) => {
    const results = report.results.filter((result) => result.candidateId === candidate.id)
    const total = results.length
    const tokenSum = (field: 'inputTokens' | 'outputTokens') =>
      total && results.every((result) => result.trace.usageSource !== 'unknown' && result.trace[field] !== undefined)
        ? results.reduce((sum, result) => sum + result.trace[field]!, 0)
        : null
    const costs = results.map((result) => result.trace.cost)
    const cost =
      total && costs.every((entry) => entry?.complete) && new Set(costs.map((entry) => entry!.currency)).size === 1
        ? { currency: costs[0]!.currency, amount: costs.reduce((sum, entry) => sum + entry!.amount, 0) }
        : null
    return {
      ...candidate,
      attempts: total,
      successRate: total ? results.filter((result) => result.status === 'passed').length / total : 0,
      toolCalls: results.reduce((sum, result) => sum + result.toolCalls, 0),
      inputTokens: tokenSum('inputTokens'),
      outputTokens: tokenSum('outputTokens'),
      meanDurationMs: total ? results.reduce((sum, result) => sum + result.durationMs, 0) / total : 0,
      cost
    }
  })
}

export function compareEvaluations(baseline: EvaluationReport, current: EvaluationReport) {
  const suite = (report: EvaluationReport) =>
    JSON.stringify(report.scenarios.map(({ id, version }) => [id, version]).sort(([a], [b]) => a.localeCompare(b)))
  if (
    baseline.version !== 1 ||
    current.version !== 1 ||
    suite(baseline) !== suite(current) ||
    baseline.repetitions !== current.repetitions ||
    baseline.timeoutMs !== current.timeoutMs
  ) {
    throw new Error('Comparison requires identical scenario versions, repetitions and deadlines')
  }
  for (const report of [baseline, current]) {
    const cells = new Set(
      report.results.map(({ candidateId, scenarioId, attempt }) => JSON.stringify([candidateId, scenarioId, attempt]))
    )
    if (
      cells.size !== report.candidates.length * report.scenarios.length * report.repetitions ||
      cells.size !== report.results.length ||
      report.results.some(
        (result) =>
          !report.candidates.some((candidate) => candidate.id === result.candidateId) ||
          !report.scenarios.some((scenario) => scenario.id === result.scenarioId) ||
          !Number.isInteger(result.attempt) ||
          result.attempt < 1 ||
          result.attempt > report.repetitions
      )
    )
      throw new Error('Comparison requires a complete, unique evaluation matrix')
  }
  const previous = summarizeEvaluation(baseline)
  return summarizeEvaluation(current).map((row) => {
    const before = previous.find((entry) => entry.id === row.id)
    if (!before) throw new Error(`Baseline is missing candidate ${row.id}`)
    return {
      candidateId: row.id,
      successRateDelta: row.successRate - before.successRate,
      costDelta:
        row.cost && before.cost && row.cost.currency === before.cost.currency
          ? { currency: row.cost.currency, amount: row.cost.amount - before.cost.amount }
          : null,
      toolCallsDelta: row.toolCalls - before.toolCalls,
      meanDurationMsDelta: row.meanDurationMs - before.meanDurationMs
    }
  })
}
