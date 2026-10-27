import type { CompactionResult, CompactionPolicy, AgentCompactionConfig } from '@keundal/compaction'
import type { RunAgentInput } from '@keundal/core'

import { SummaryCompactionConfigSchema } from './index.js'

function policy(value: unknown): CompactionPolicy {
  if (value === undefined) value = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid compaction config')
  const config = value as CompactionPolicy
  const parsed = SummaryCompactionConfigSchema['~standard'].validate(value)
  if (parsed.issues) throw new Error(parsed.issues.map((issue) => issue.message).join('; '))
  const threshold = config.threshold ?? 0.8
  const reserveTokens = config.reserveTokens ?? 0
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
    throw new Error('compaction threshold must be greater than 0 and at most 1')
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 0)
    throw new Error('compaction reserveTokens must be a non-negative integer')
  return { ...parsed.value, threshold, reserveTokens }
}

export function parseCompactionConfig(value: unknown): AgentCompactionConfig {
  const base = policy(value)
  const models = (value as AgentCompactionConfig | undefined)?.models
  if (models === undefined) return base
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('invalid compaction models')
  const overrides: Record<string, CompactionPolicy> = Object.create(null)
  for (const [model, override] of Object.entries(models)) {
    if (!model.trim() || !override || typeof override !== 'object' || Array.isArray(override))
      throw new Error('invalid model compaction policy')
    overrides[model] = policy({ ...base, ...override })
  }
  return { ...base, models: overrides }
}

export interface PreparedCompaction {
  readonly input: RunAgentInput
  readonly controller: AbortController
  readonly sourceSignal: AbortSignal
  readonly detach: () => void
  task: Promise<CompactionResult | undefined>
  result?: CompactionResult
}

// ID가 같아도 내용이 수정되었거나 순서가 바뀌면 이전 결과를 사용하지 않습니다.
export function applyPrepared(entry: PreparedCompaction, input: RunAgentInput): CompactionResult | undefined {
  if (!entry.result || !matchesPrepared(entry, input)) return
  const originalIds = new Set(entry.input.messages.map((message) => message.id))
  const appended = input.messages.filter((message) => !originalIds.has(message.id))
  const calls = (request: readonly RunAgentInput['messages'][number][]) =>
    new Set(
      request.flatMap((message) =>
        message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []
      )
    )
  const originalCalls = calls(entry.input.messages)
  const retainedCalls = calls(entry.result.messages)
  if (
    appended.some(
      (message) =>
        message.role === 'tool' && originalCalls.has(message.toolCallId) && !retainedCalls.has(message.toolCallId)
    )
  )
    return
  const sourceIds = new Set(entry.result.sourceMessageIds)
  const summary = entry.result.messages.find((message) => !originalIds.has(message.id))
  if (!summary) return
  const messages: RunAgentInput['messages'] = []
  let inserted = false
  for (const message of input.messages) {
    if (sourceIds.has(message.id)) {
      if (!inserted) {
        messages.push(summary)
        inserted = true
      }
    } else messages.push(message)
  }
  return { ...entry.result, messages }
}

export function matchesPrepared(entry: PreparedCompaction, input: RunAgentInput): boolean {
  if (entry.controller.signal.aborted) return false
  const original = entry.input
  if (original.threadId !== input.threadId || original.messages.length > input.messages.length) return false
  const metadata = (candidate: RunAgentInput) => {
    const { runId: _runId, messages: _messages, state: _state, ...rest } = candidate
    return JSON.stringify(rest)
  }
  try {
    if (metadata(original) !== metadata(input)) return false
    const instruction = (message: RunAgentInput['messages'][number]) =>
      message.role === 'system' || message.role === 'developer'
    const currentInstructions = new Map(input.messages.filter(instruction).map((message) => [message.id, message]))
    if (
      !original.messages
        .filter(instruction)
        .every((message) => JSON.stringify(message) === JSON.stringify(currentInstructions.get(message.id)))
    )
      return false
    const originalConversation = original.messages.filter((message) => !instruction(message))
    const currentConversation = input.messages.filter((message) => !instruction(message))
    return originalConversation.every(
      (message, index) => JSON.stringify(message) === JSON.stringify(currentConversation[index])
    )
  } catch {
    return false
  }
}

export async function waitForPreparation<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const aborted = Promise.withResolvers<never>()
  const abort = () => aborted.reject(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await Promise.race([task, aborted.promise])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
