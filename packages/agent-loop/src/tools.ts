import {
  CONTEXT_MESSAGE_EVENT,
  CONTEXT_MESSAGE_PREFIX,
  EventType,
  MessageAssembly,
  readTraceSpans,
  traceEvent,
  type AGUIEvent,
  type LLMEvent,
  type LLMRequest,
  type LLMService,
  type RunAgentInput,
  type TraceSpan
} from '@keundal/core'
import { TOOL_PROGRESS_EVENT } from '@keundal/tools'
import type { ExecutableTool, ToolExecutionContext } from '@keundal/tools'
export { TOOL_PROGRESS_EVENT } from '@keundal/tools'
export type { ExecutableTool, ToolExecutionContext } from '@keundal/tools'
export function parseTools(value: unknown): ExecutableTool[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('tools must be an array')
  const names = new Set<string>()
  return value.map((tool: unknown) => {
    if (
      !isObject(tool) ||
      typeof tool.name !== 'string' ||
      !tool.name.trim() ||
      typeof tool.description !== 'string' ||
      !isObject(tool.parameters) ||
      typeof tool.execute !== 'function'
    ) {
      throw new Error('each tool requires a name, description, parameters object and execute function')
    }
    if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`)
    names.add(tool.name)
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      execute: tool.execute as ExecutableTool['execute']
    }
  })
}

export function addTools(input: RunAgentInput, tools: readonly ExecutableTool[]): RunAgentInput {
  const names = new Set(input.tools.map((tool) => tool.name))
  const definitions = tools.map(({ name, description, parameters }) => {
    if (names.has(name)) throw new Error(`tool is defined in both input and agent config: ${name}`)
    return { name, description, parameters }
  })
  return { ...input, tools: [...input.tools, ...definitions] }
}

interface PendingCall {
  readonly id: string
  readonly name: string
  arguments: string
  ended: boolean
}

export async function* streamWithTools(
  llm: LLMService,
  request: LLMRequest,
  tools: readonly ExecutableTool[],
  maxToolRounds: number,
  prepareInput: (input: RunAgentInput) => Promise<RunAgentInput>,
  signal: AbortSignal,
  options: {
    parallel?: boolean
    stream?: LLMService['stream']
    maxToolCalls?: number
    resolveTools?: () => readonly ExecutableTool[] | Promise<readonly ExecutableTool[]>
    traceContext?: (call: { id: string; name: string }) => { traceId: string; parentSpanId: string }
    trace?: {
      onToolStart(call: { id: string; name: string }): AGUIEvent | undefined
      onToolEnd(call: { id: string; name: string; status: 'completed' | 'failed' | 'cancelled' }): AGUIEvent | undefined
    }
  } = {}
): AsyncGenerator<LLMEvent> {
  let registered = new Map(tools.map((tool) => [tool.name, tool]))
  const usedIds = new Set(
    request.input.messages.flatMap((message) =>
      message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []
    )
  )
  let current = request
  const configuredNames = new Set(tools.map((tool) => tool.name))
  const initialInputNames = new Set(request.input.tools.map((tool) => tool.name))
  let previousResolvedNames = new Set<string>()
  let resolvedToolsPrepared = false
  const refreshResolvedTools = async (input: RunAgentInput): Promise<RunAgentInput> => {
    const resolvedTools = await options.resolveTools!()
    const allTools = [...tools, ...resolvedTools]
    registered = new Map(allTools.map((tool) => [tool.name, tool]))
    if (registered.size !== allTools.length) throw new Error('duplicate tool name in resolved tool catalog')
    for (const tool of resolvedTools) {
      if (initialInputNames.has(tool.name) && !configuredNames.has(tool.name)) {
        throw new Error(`deferred tool is defined in both input and deferred catalog: ${tool.name}`)
      }
    }
    const managedNames = new Set([...configuredNames, ...previousResolvedNames])
    const retainedTools = input.tools.filter((tool) => !managedNames.has(tool.name))
    const definitions = allTools.map(({ name, description, parameters }) => ({ name, description, parameters }))
    const retainedNames = new Set(retainedTools.map((tool) => tool.name))
    for (const definition of definitions) {
      if (retainedNames.has(definition.name))
        throw new Error(`tool is defined in both input and agent config: ${definition.name}`)
    }
    previousResolvedNames = new Set(resolvedTools.map((tool) => tool.name))
    return { ...input, tools: [...retainedTools, ...definitions] }
  }
  let rounds = 0
  let totalCalls = 0
  const maxToolCalls = options.maxToolCalls ?? 32
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new Error('maxToolCalls must be a positive integer')
  }
  while (true) {
    signal.throwIfAborted()
    if (options.resolveTools && !resolvedToolsPrepared) {
      current = { ...current, input: await refreshResolvedTools(current.input) }
    }
    resolvedToolsPrepared = false
    const assembly = new MessageAssembly()
    const calls = new Map<string, PendingCall>()
    for await (const event of options.stream ? options.stream(current, { signal }) : llm.stream(current, { signal })) {
      signal.throwIfAborted()
      if (event.type === EventType.TOOL_CALL_START) {
        if (usedIds.has(event.toolCallId)) throw new Error(`duplicate tool call id: ${event.toolCallId}`)
        if (totalCalls >= maxToolCalls) throw new Error(`maximum tool calls exceeded: ${maxToolCalls}`)
        totalCalls++
        usedIds.add(event.toolCallId)
        calls.set(event.toolCallId, {
          id: event.toolCallId,
          name: event.toolCallName,
          arguments: '',
          ended: false
        })
      } else if (event.type === EventType.TOOL_CALL_ARGS || event.type === EventType.TOOL_CALL_END) {
        const call = calls.get(event.toolCallId)
        if (!call || call.ended) throw new Error(`tool call is not open: ${event.toolCallId}`)
        if (event.type === EventType.TOOL_CALL_ARGS) call.arguments += event.delta
        else call.ended = true
      }
      assembly.apply(event)
      yield event
    }
    signal.throwIfAborted()
    if (!calls.size) return
    if (rounds >= maxToolRounds) throw new Error(`maximum tool rounds exceeded: ${maxToolRounds}`)

    // 같은 응답의 모든 호출을 먼저 확인하여 잘못된 호출이 있으면 실행을 시작하지 않습니다.
    const executions = [...calls.values()].map((call) => {
      if (!call.ended) throw new Error(`incomplete tool call: ${call.id}`)
      const tool = registered.get(call.name)
      if (!tool) throw new Error(`no executor registered for tool: ${call.name}`)
      let args: unknown
      try {
        args = JSON.parse(call.arguments)
      } catch (cause) {
        throw new Error(`invalid JSON arguments for tool: ${call.name}`, { cause })
      }
      if (!isObject(args)) throw new Error(`tool arguments must be a JSON object: ${call.name}`)
      return { call, tool, args }
    })
    const executionContext = (call: PendingCall): ToolExecutionContext => ({
      threadId: request.input.threadId,
      runId: request.input.runId,
      toolCallId: call.id,
      signal
    })
    const batches = options.parallel ? [executions] : executions.map((execution) => [execution])
    for (const batch of batches) {
      for await (const event of executeBatch(batch, executionContext, signal, options.trace, options.traceContext)) {
        assembly.apply(event)
        yield event
      }
    }
    rounds++
    signal.throwIfAborted()
    let next = { ...current.input, messages: [...current.input.messages, ...assembly.messages] }
    if (options.resolveTools) {
      next = await refreshResolvedTools(next)
      resolvedToolsPrepared = true
    }
    const prepared = await prepareInput(next)
    signal.throwIfAborted()
    const previousIds = new Set(next.messages.map((message) => message.id))
    for (const message of prepared.messages) {
      if (message.id.startsWith(CONTEXT_MESSAGE_PREFIX) && !previousIds.has(message.id)) {
        yield { type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value: message }
        signal.throwIfAborted()
      }
    }
    current = { ...current, input: prepared }
  }
}

async function* executeBatch(
  executions: { call: PendingCall; tool: ExecutableTool; args: Record<string, unknown> }[],
  context: (call: PendingCall) => ToolExecutionContext,
  signal: AbortSignal,
  trace?: {
    onToolStart(call: { id: string; name: string }): AGUIEvent | undefined
    onToolEnd(call: { id: string; name: string; status: 'completed' | 'failed' | 'cancelled' }): AGUIEvent | undefined
  },
  traceContext?: (call: { id: string; name: string }) => { traceId: string; parentSpanId: string }
): AsyncGenerator<LLMEvent> {
  const progress: LLMEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  let onAbort: (() => void) | undefined
  const notify = () => wake?.()
  signal.addEventListener('abort', notify, { once: true })
  try {
    signal.throwIfAborted()
    const pending = executions.map(({ call, tool, args }) => {
      let settled = false
      let started = false
      let ended = false
      const finish = (status: 'completed' | 'failed' | 'cancelled') => {
        if (!started || ended) return
        ended = true
        const event = trace?.onToolEnd({ id: call.id, name: call.name, status })
        if (!event) return
        if (event.type !== EventType.CUSTOM) throw new Error('tool trace hooks must return CUSTOM events')
        progress.push(event)
        notify()
      }
      const task = Promise.resolve()
        .then(async () => {
          try {
            signal.throwIfAborted()
            const callInfo = { id: call.id, name: call.name }
            const toolTraceContext = traceContext?.(callInfo)
            const event = trace?.onToolStart(callInfo)
            if (event) {
              if (event.type !== EventType.CUSTOM) throw new Error('tool trace hooks must return CUSTOM events')
              progress.push(event)
              notify()
            }
            started = true
            const value = await tool.execute(args, {
              ...context(call),
              ...toolTraceContext,
              reportTrace(span: TraceSpan) {
                if (closed || signal.aborted || !toolTraceContext) return
                const validated = readTraceSpans([traceEvent(span)], undefined, 1)[0]
                if (!validated || validated.traceId !== toolTraceContext.traceId) return
                const safeSpan: TraceSpan = {
                  version: 1,
                  traceId: validated.traceId,
                  spanId: validated.spanId,
                  ...(validated.parentSpanId ? { parentSpanId: validated.parentSpanId } : {}),
                  runId: validated.runId,
                  ...(validated.toolCallId ? { toolCallId: validated.toolCallId } : {}),
                  kind: validated.kind,
                  name: validated.name,
                  sequence: validated.sequence,
                  startedAt: validated.startedAt,
                  ...(validated.endedAt === undefined ? {} : { endedAt: validated.endedAt }),
                  status: validated.status,
                  ...(validated.model ? { model: validated.model } : {}),
                  ...(validated.usage
                    ? {
                        usage: {
                          source: validated.usage.source,
                          ...(validated.usage.inputTokens === undefined
                            ? {}
                            : { inputTokens: validated.usage.inputTokens }),
                          ...(validated.usage.outputTokens === undefined
                            ? {}
                            : { outputTokens: validated.usage.outputTokens }),
                          ...(validated.usage.cacheReadTokens === undefined
                            ? {}
                            : { cacheReadTokens: validated.usage.cacheReadTokens }),
                          ...(validated.usage.cacheWriteTokens === undefined
                            ? {}
                            : { cacheWriteTokens: validated.usage.cacheWriteTokens })
                        }
                      }
                    : {}),
                  ...(validated.cost
                    ? {
                        cost: {
                          currency: validated.cost.currency,
                          amount: validated.cost.amount,
                          source: validated.cost.source
                        }
                      }
                    : {}),
                  ...(validated.ttftMs === undefined ? {} : { ttftMs: validated.ttftMs }),
                  ...(validated.error ? { error: validated.error } : {}),
                  ...(validated.detached ? { detached: true } : {})
                }
                progress.push(traceEvent(safeSpan))
                notify()
              },
              reportProgress(value) {
                if (closed || signal.aborted) return
                progress.push({
                  type: EventType.CUSTOM,
                  name: TOOL_PROGRESS_EVENT,
                  value: { toolCallId: call.id, value }
                })
                notify()
              }
            })
            if (typeof value !== 'string') throw new Error(`tool result must be a string: ${tool.name}`)
            finish(signal.aborted ? 'cancelled' : 'completed')
            return { ok: true as const, value }
          } catch (error: unknown) {
            finish(signal.aborted ? 'cancelled' : 'failed')
            return { ok: false as const, error }
          }
        })
        .finally(() => {
          settled = true
          notify()
        })
      return { call, tool, task, settled: () => settled, started: () => started, finish }
    })
    onAbort = () => {
      for (const entry of pending) {
        if (entry.started()) entry.finish('cancelled')
      }
    }
    signal.addEventListener('abort', onAbort, { once: true })
    for (const entry of pending) {
      while (true) {
        signal.throwIfAborted()
        const event = progress.shift()
        if (event) {
          yield event
          continue
        }
        if (entry.settled()) break
        const waiting = Promise.withResolvers<void>()
        wake = waiting.resolve
        await waiting.promise
      }
      const result = await entry.task
      signal.throwIfAborted()
      if (!result.ok) throw result.error
      if (typeof result.value !== 'string') throw new Error(`tool result must be a string: ${entry.tool.name}`)
      yield {
        type: EventType.TOOL_CALL_RESULT,
        messageId: globalThis.crypto.randomUUID(),
        toolCallId: entry.call.id,
        role: 'tool',
        content: result.value
      }
    }
  } finally {
    closed = true
    if (onAbort) signal.removeEventListener('abort', onAbort)
    signal.removeEventListener('abort', notify)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
