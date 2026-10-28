import { EventType, MessageAssembly, type AGUIEvent, type ExecutionOptions, type RunAgentInput } from '@keundal/core'
import type { TaskService } from '@keundal/task'
import { TOOL_APPROVAL_EVENT, isToolApprovalRecord } from '@keundal/tool-approval'
import type { ExecutableTool } from '@keundal/tools'
import { readTraceSpans } from '@keundal/trace'

import { type SubagentRole } from './subagent.js'

export const SUBAGENT_TOOL_NAME = 'delegate_task'

export function subagentTool(
  run: (
    input: RunAgentInput,
    options: ExecutionOptions & { traceId?: string; parentSpanId?: string },
    role?: SubagentRole
  ) => AsyncIterable<AGUIEvent>,
  maxActive: number,
  roles: readonly SubagentRole[] = [],
  tasks?: TaskService,
  runBackground = run
): ExecutableTool {
  // One tool instance belongs to one parent run. Reserve before any async work.
  let active = 0
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      'Delegate a self-contained task to a subagent and wait for its final answer. It inherits the parent model and tools unless its configured role overrides them, but receives no parent conversation. Include all necessary context in the task. It cannot delegate further. Independent calls can run in parallel. Check the returned status: failed or rejected tasks are not complete. At capacity, retry in a later round after current tasks finish.' +
      (tasks
        ? ' Set background=true to enqueue a separately owned task and return its task ID immediately. It survives parent completion or cancellation, but not process restart. Use get_background_task to check progress and cancel_background_task to cancel. Never treat queued or running as completed.'
        : '') +
      (roles.length
        ? ` Available roles (name and description): ${JSON.stringify(roles.map(({ name, description }) => ({ name, description })))}`
        : ''),
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Complete task instructions and necessary context.' },
        ...(tasks ? { background: { type: 'boolean', description: 'Run independently of this parent run.' } } : {}),
        ...(roles.length
          ? {
              role: {
                type: 'string',
                enum: roles.map((role) => role.name),
                description: 'Optional role whose instructions the subagent follows. Omit for a general task.'
              }
            }
          : {}),
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
        Object.keys(args).some(
          (key) => key !== 'task' && key !== 'label' && key !== 'role' && !(tasks && key === 'background')
        )
      ) {
        throw new Error('delegate_task requires a non-empty task and no additional arguments')
      }
      if (
        args.label !== undefined &&
        (typeof args.label !== 'string' || !args.label.trim() || args.label.length > 80)
      ) {
        throw new Error('delegate_task label must be a non-empty string of at most 80 characters')
      }
      const role = roles.find((role) => role.name === args.role)
      if (args.role !== undefined && !role) throw new Error('delegate_task role must name a configured role')
      const label = typeof args.label === 'string' ? args.label.trim() : role?.name
      if (args.background !== undefined && typeof args.background !== 'boolean')
        throw new Error('background must be a boolean')
      if (tasks && args.background === true) {
        const snapshot = await tasks.enqueue(
          {
            parentThreadId: context.threadId,
            parentRunId: context.runId,
            label,
            input: {
              threadId: globalThis.crypto.randomUUID(),
              runId: globalThis.crypto.randomUUID(),
              state: {
                subagent: {
                  parentThreadId: context.threadId,
                  parentRunId: context.runId,
                  toolCallId: context.toolCallId,
                  ...(role ? { role: role.name } : {}),
                  ...(label ? { label } : {}),
                  background: true
                }
              },
              context: [],
              tools: [],
              messages: [
                ...(role
                  ? [{ id: globalThis.crypto.randomUUID(), role: 'system' as const, content: role.instructions }]
                  : []),
                { id: globalThis.crypto.randomUUID(), role: 'user', content: args.task }
              ]
            }
          },
          (input, options) => runBackground(input, options, role)
        )
        return JSON.stringify({
          taskId: snapshot.id,
          status: snapshot.status,
          threadId: snapshot.threadId,
          runId: snapshot.runId
        })
      }
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
                  ...(role ? { role: role.name } : {}),
                  ...(label ? { label } : {})
                }
              },
              context: [],
              tools: [],
              messages: [
                ...(role
                  ? [{ id: globalThis.crypto.randomUUID(), role: 'system' as const, content: role.instructions }]
                  : []),
                { id: globalThis.crypto.randomUUID(), role: 'user', content: args.task }
              ]
            },
            {
              signal: context.signal,
              ...(context.traceId ? { traceId: context.traceId } : {}),
              ...(context.parentSpanId ? { parentSpanId: context.parentSpanId } : {})
            },
            role
          )) {
            if (event.type === EventType.CUSTOM) {
              if (event.name === TOOL_APPROVAL_EVENT && isToolApprovalRecord(event.value)) {
                context.reportProgress?.({ status: 'running', threadId, runId, approval: event.value })
              }
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

/** Lookup and cancellation do not resume or re-execute a task. */
export function backgroundTaskTools(tasks: TaskService): ExecutableTool[] {
  return [
    {
      name: 'get_background_task',
      description:
        'Read a background task status, partial answer, final answer or error by taskId. This never restarts it.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', minLength: 1 } },
        required: ['taskId'],
        additionalProperties: false
      },
      async execute(args, context) {
        context.signal.throwIfAborted()
        if (typeof args.taskId !== 'string' || !args.taskId || Object.keys(args).length !== 1)
          throw new Error('taskId is required')
        return JSON.stringify((await tasks.get(args.taskId)) ?? { error: 'Task not found' })
      }
    },
    {
      name: 'cancel_background_task',
      description: 'Cancel a queued or running background task by taskId. This does not undo external side effects.',
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string', minLength: 1 } },
        required: ['taskId'],
        additionalProperties: false
      },
      async execute(args, context) {
        context.signal.throwIfAborted()
        if (typeof args.taskId !== 'string' || !args.taskId || Object.keys(args).length !== 1)
          throw new Error('taskId is required')
        return JSON.stringify({ cancelled: await tasks.cancel(args.taskId) })
      }
    }
  ]
}
