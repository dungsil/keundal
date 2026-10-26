import type { AgentConfig } from '@keundal/agent-loop'
import { EventType, type AGUIEvent, type RunAgentInput } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import type { ToolExecutionContext } from '@keundal/tools'
import { readTraceSpans, LLM_USAGE_EVENT, TRACE_EVENT, summarizeTrace, llmUsageEvent } from '@keundal/trace'
import { Context } from 'cordis'
import { expect, test } from 'vitest'

const input: RunAgentInput = {
  threadId: 'nested-trace-thread',
  runId: 'nested-trace-parent',
  state: {},
  context: [],
  tools: [],
  messages: [{ id: 'question', role: 'user', content: 'delegate this' }]
}

function* text(id: string, content: string): Generator<LLMEvent> {
  yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
  yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: content }
  yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
}

test('부모 Journal은 검증한 자식 모델 Trace만 전달하고 민감한 추가 필드를 제거한다', async (t) => {
  const ctx = new Context()
  class LLM extends LLMService {
    async getModel() {
      return { contextWindow: 2000, maxOutputTokens: 100 }
    }
    async countTokens() {
      return 10
    }
    async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
      if (request.input.state.subagent) {
        if (request.input.messages.some((message) => message.role === 'tool')) {
          yield* text('child-answer', 'private child response')
          yield llmUsageEvent({ source: 'provider', inputTokens: 17, outputTokens: 4 })
        } else {
          yield { type: EventType.TOOL_CALL_START, toolCallId: 'child-probe-call', toolCallName: 'child-probe' }
          yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'child-probe-call', delta: '{}' }
          yield { type: EventType.TOOL_CALL_END, toolCallId: 'child-probe-call' }
          yield llmUsageEvent({ source: 'provider', inputTokens: 13, outputTokens: 1 })
        }
        return
      }
      const hasDelegateResult = request.input.messages.some((message) => message.role === 'tool')
      if (!hasDelegateResult) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'delegate-call', toolCallName: 'delegate_task' }
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: 'delegate-call',
          delta: '{"task":"private child argument"}'
        }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'delegate-call' }
        return
      }
      yield* text('parent-answer', 'finished')
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  const childProbe = {
    name: 'child-probe',
    description: 'Emit a trace metadata probe',
    parameters: { type: 'object' },
    execute: (_args: Record<string, unknown>, context: ToolExecutionContext) => {
      context.reportTrace?.(
        Object.assign(
          {
            version: 1 as const,
            spanId: 'probe-extra-span',
            traceId: context.traceId!,
            parentSpanId: context.parentSpanId!,
            runId: context.runId,
            toolCallId: context.toolCallId,
            kind: 'tool' as const,
            name: 'child-probe',
            sequence: 99,
            startedAt: Date.now(),
            status: 'running' as const
          },
          { arguments: 'private trace argument', result: 'private trace result', apiKey: 'private trace api key' }
        )
      )
      return 'probe result'
    }
  }
  const agent = await ctx.plugin(agentPlugin, {
    model: 'nested-model',
    maxOutputTokens: 100,
    subagents: true,
    tools: [childProbe]
  } satisfies Partial<AgentConfig>)
  t.onTestFinished(async () => {
    await agent.dispose()
    await store.dispose()
    await llm.dispose()
  })

  const events: AGUIEvent[] = []
  for await (const event of ctx.agent.run(input)) events.push(event)
  const snapshot = await ctx.generation.get(input.runId)
  expect(snapshot?.status).toBe('completed')
  const traceEvents = snapshot!.journal
    .map((entry) => entry.event)
    .filter((event) => event.type === EventType.CUSTOM && event.name === TRACE_EVENT)
  const spans = readTraceSpans(traceEvents)
  const root = spans.find((span) => span.runId === input.runId && span.kind === 'agent')!
  const parentTool = spans.find((span) => span.runId === input.runId && span.kind === 'tool')!
  const childRoot = spans.find((span) => span.runId !== input.runId && span.kind === 'agent')!
  const childModels = spans.filter((span) => span.runId === childRoot.runId && span.kind === 'model')

  expect(childRoot.traceId).toBe(root.traceId)
  expect(childRoot.parentSpanId).toBe(parentTool.spanId)
  expect(childModels).toHaveLength(2)
  expect(spans.find((span) => span.spanId === 'probe-extra-span')).toMatchObject({
    kind: 'tool',
    runId: childRoot.runId
  })
  expect(summarizeTrace(spans)).toMatchObject({ inputTokens: 30, outputTokens: 5 })
  const serializedTrace = JSON.stringify(traceEvents)
  expect(serializedTrace).not.toContain('private child response')
  expect(serializedTrace).not.toContain('private child argument')
  expect(serializedTrace).not.toContain('private trace argument')
  expect(serializedTrace).not.toContain('private trace result')
  expect(serializedTrace).not.toContain('private trace api key')
  expect(
    events.some((event) => event.type === EventType.TEXT_MESSAGE_CONTENT && event.delta === 'private child response')
  ).toBe(false)
  expect(snapshot?.journal.map((entry) => entry.event)).toEqual(events)
  expect(
    snapshot?.journal.some((entry) => entry.event.type === EventType.CUSTOM && entry.event.name === LLM_USAGE_EVENT)
  ).toBe(false)
})
