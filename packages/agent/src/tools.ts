import { TOOL_PROGRESS_EVENT } from '@keundal/agent-contract'
import type { ExecutableTool, ToolExecutionContext } from '@keundal/agent-contract'
import {
  CONTEXT_MESSAGE_EVENT,
  CONTEXT_MESSAGE_PREFIX,
  EventType,
  MessageAssembly,
  type LLMEvent,
  type LLMRequest,
  type LLMService,
  type RunAgentInput
} from '@keundal/core'
export { TOOL_PROGRESS_EVENT } from '@keundal/agent-contract'
export type { ExecutableTool, ToolExecutionContext } from '@keundal/agent-contract'
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
  options: { parallel?: boolean; stream?: LLMService['stream']; maxToolCalls?: number } = {}
): AsyncGenerator<LLMEvent> {
  const registered = new Map(tools.map((tool) => [tool.name, tool]))
  const usedIds = new Set(
    request.input.messages.flatMap((message) =>
      message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []
    )
  )
  let current = request
  let rounds = 0
  let totalCalls = 0
  const maxToolCalls = options.maxToolCalls ?? 32
  if (!Number.isSafeInteger(maxToolCalls) || maxToolCalls <= 0) {
    throw new Error('maxToolCalls must be a positive integer')
  }
  while (true) {
    signal.throwIfAborted()
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
      for await (const event of executeBatch(batch, executionContext, signal)) {
        assembly.apply(event)
        yield event
      }
    }
    rounds++
    signal.throwIfAborted()
    const next = { ...current.input, messages: [...current.input.messages, ...assembly.messages] }
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
  signal: AbortSignal
): AsyncGenerator<LLMEvent> {
  const progress: LLMEvent[] = []
  let wake: (() => void) | undefined
  let closed = false
  const notify = () => wake?.()
  signal.addEventListener('abort', notify, { once: true })
  try {
    signal.throwIfAborted()
    const pending = executions.map(({ call, tool, args }) => {
      let settled = false
      const task = Promise.resolve()
        .then(() => {
          signal.throwIfAborted()
          return tool.execute(args, {
            ...context(call),
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
        })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error })
        )
        .finally(() => {
          settled = true
          notify()
        })
      return { call, tool, task, settled: () => settled }
    })
    for (const entry of pending) {
      while (true) {
        signal.throwIfAborted()
        const event = progress.shift()
        if (event) {
          yield event
          continue
        }
        if (entry.settled()) break
        await new Promise<void>((resolve) => {
          wake = resolve
        })
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
    signal.removeEventListener('abort', notify)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
