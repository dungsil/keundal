import {
  EventType,
  MessageAssembly,
  readTraceSpans,
  type AGUIEvent,
  type ExecutionOptions,
  type RunAgentInput
} from '@keundal/core'

import type { ExecutableTool } from './tools.js'

export const SUBAGENT_TOOL_NAME = 'delegate_task'

export function subagentTool(
  run: (
    input: RunAgentInput,
    options: ExecutionOptions & { traceId?: string; parentSpanId?: string }
  ) => AsyncIterable<AGUIEvent>,
  maxActive: number
): ExecutableTool {
  // One tool instance belongs to one parent run. Reserve before any async work.
  let active = 0
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      'Delegate a self-contained task to a subagent and wait for its final answer. It has the same model and tools but no parent conversation. Include all necessary context in the task. It cannot delegate further. Independent calls can run in parallel. Check the returned status: failed or rejected tasks are not complete. At capacity, retry in a later round after current tasks finish.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete task instructions and necessary context.' },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 80,
          description: 'Short name for this task in the progress UI.'
        }
      },
      required: ['task'],
      additionalProperties: false
    },
    async execute(args, context) {
      context.signal.throwIfAborted()
      if (
        typeof args.task !== 'string' ||
        !args.task.trim() ||
        Object.keys(args).some((key) => key !== 'task' && key !== 'label')
      ) {
        throw new Error('delegate_task requires a non-empty task and no additional arguments')
      }
      if (
        args.label !== undefined &&
        (typeof args.label !== 'string' || !args.label.trim() || args.label.length > 80)
      ) {
        throw new Error('delegate_task label must be a non-empty string of at most 80 characters')
      }
      const label = typeof args.label === 'string' ? args.label.trim() : undefined
      if (active >= maxActive) {
        const error = {
          code: 'ACTIVE_LIMIT_REACHED',
          message: `At most ${maxActive} subagents can run at once. Retry after the current tasks finish.`
        }
        context.reportProgress?.({ status: 'failed', label, error: error.message })
        return JSON.stringify({ status: 'rejected', error })
      }
      active++
      try {
        const threadId = globalThis.crypto.randomUUID()
        const runId = globalThis.crypto.randomUUID()
        const report = (status: 'running' | 'completed' | 'failed', error?: string) =>
          context.reportProgress?.({ status, threadId, runId, label, ...(error ? { error } : {}) })
        report('running')
        const assembly = new MessageAssembly()
        const output = () =>
          assembly.messages.findLast(
            (message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()
          )?.content ?? ''
        try {
          let completed = false
          for await (const event of run(
            {
              threadId,
              runId,
              state: {
                subagent: {
                  parentThreadId: context.threadId,
                  parentRunId: context.runId,
                  toolCallId: context.toolCallId,
                  ...(label ? { label } : {})
                }
              },
              context: [],
              tools: [],
              messages: [{ id: globalThis.crypto.randomUUID(), role: 'user', content: args.task }]
            },
            {
              signal: context.signal,
              ...(context.traceId ? { traceId: context.traceId } : {}),
              ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {})
            }
          )) {
            if (event.type === EventType.CUSTOM) {
              const span = readTraceSpans([event], undefined, 1)[0]
              if (
                span &&
                span.runId === runId &&
                span.traceId === context.traceId &&
                (span.kind !== 'agent' || span.parentSpanId === context.parentSpanId)
              )
                context.reportTrace?.(span)
            }
            context.signal.throwIfAborted()
            if (event.type === EventType.RUN_ERROR) throw new Error(`subagent failed: ${event.message}`)
            if (event.type === EventType.RUN_FINISHED) {
              if (event.outcome?.type !== 'success') throw new Error('subagent did not complete successfully')
              completed = true
            }
            assembly.apply(event)
          }
          context.signal.throwIfAborted()
          if (!completed) throw new Error('subagent ended without completing')
          report('completed')
          return JSON.stringify({ status: 'completed', threadId, runId, content: output() })
        } catch (error) {
          // Cancellation belongs to the whole parent run, never a recoverable tool result.
          context.signal.throwIfAborted()
          const message = error instanceof Error ? error.message : 'Subagent execution failed'
          report('failed', message)
          return JSON.stringify({
            status: 'failed',
            threadId,
            runId,
            content: output(),
            error: { code: 'EXECUTION_FAILED', message }
          })
        }
      } finally {
        active--
      }
    }
  }
}
