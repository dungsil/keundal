import { EventType, MessageAssembly, type AGUIEvent, type ExecutionOptions, type RunAgentInput } from '@keundal/core'

import type { ExecutableTool } from './tools.js'

export const SUBAGENT_TOOL_NAME = 'delegate_task'

export function subagentTool(
  run: (input: RunAgentInput, options: ExecutionOptions) => AsyncIterable<AGUIEvent>
): ExecutableTool {
  return {
    name: SUBAGENT_TOOL_NAME,
    description:
      'Delegate a self-contained task to a subagent and wait for its final answer. It has the same model and tools but no parent conversation. Include all necessary context in the task. It cannot delegate further.',
    parameters: {
      type: 'object',
      properties: { task: { type: 'string', description: 'Complete task instructions and necessary context.' } },
      required: ['task'],
      additionalProperties: false
    },
    async execute(args, context) {
      context.signal.throwIfAborted()
      if (typeof args.task !== 'string' || !args.task.trim() || Object.keys(args).some((key) => key !== 'task')) {
        throw new Error('delegate_task requires a non-empty task and no additional arguments')
      }
      const threadId = globalThis.crypto.randomUUID()
      const runId = globalThis.crypto.randomUUID()
      const report = (status: 'running' | 'completed' | 'failed' | 'cancelled') =>
        context.reportProgress?.({ status, threadId, runId })
      report('running')
      try {
        const assembly = new MessageAssembly()
        let completed = false
        for await (const event of run(
          {
            threadId,
            runId,
            state: {
              subagent: {
                parentThreadId: context.threadId,
                parentRunId: context.runId,
                toolCallId: context.toolCallId
              }
            },
            context: [],
            tools: [],
            messages: [{ id: globalThis.crypto.randomUUID(), role: 'user', content: args.task }]
          },
          { signal: context.signal }
        )) {
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
        const answer = assembly.messages.findLast(
          (message) => message.role === 'assistant' && !message.toolCalls?.length
        )
        report('completed')
        return JSON.stringify({ threadId, runId, content: answer?.content ?? '' })
      } catch (error) {
        report(context.signal.aborted ? 'cancelled' : 'failed')
        throw error
      }
    }
  }
}
