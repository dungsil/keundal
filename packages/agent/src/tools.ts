import {
  EventType,
  MessageAssembly,
  type AgentTool,
  type LLMEvent,
  type LLMRequest,
  type LLMService,
  type RunAgentInput
} from '@keundal/core'

export interface ToolExecutionContext {
  readonly threadId: string
  readonly runId: string
  readonly toolCallId: string
  readonly signal: AbortSignal
}

export interface ExecutableTool extends AgentTool {
  /** JSON 객체로 해석한 인자를 검증하고 실행합니다. 반환한 문자열은 도구 결과 메시지가 됩니다. */
  readonly execute: (args: Record<string, unknown>, context: ToolExecutionContext) => string | Promise<string>
}

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
  options: { parallel?: boolean } = {}
): AsyncGenerator<LLMEvent> {
  const registered = new Map(tools.map((tool) => [tool.name, tool]))
  const usedIds = new Set(
    request.input.messages.flatMap((message) =>
      message.role === 'assistant' ? (message.toolCalls ?? []).map((call) => call.id) : []
    )
  )
  let current = request
  let rounds = 0
  while (true) {
    signal.throwIfAborted()
    const assembly = new MessageAssembly()
    const calls = new Map<string, PendingCall>()
    for await (const event of llm.stream(current, { signal })) {
      signal.throwIfAborted()
      if (event.type === EventType.TOOL_CALL_START) {
        if (usedIds.has(event.toolCallId)) throw new Error(`duplicate tool call id: ${event.toolCallId}`)
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
    if (options.parallel) {
      // 실행을 겹쳐 시작하고 결과는 호출 순서대로 전달합니다. 순서가 되기 전에 실패한 실행이
      // 있으면 그 오류를 전달하고, 아직 전달하지 않은 나머지 실행의 결과는 기록하지 않습니다.
      // 감싼 거부는 순서가 될 때까지 처리되지 않으므로 원래 오류를 보존하려 상자로 받습니다.
      const pending = executions.map(({ call, tool, args }) => ({
        call,
        tool,
        task: Promise.resolve(tool.execute(args, executionContext(call))).catch((error: unknown) => error)
      }))
      for (const { call, tool, task } of pending) {
        signal.throwIfAborted()
        const content = await task
        signal.throwIfAborted()
        if (content instanceof Error) throw content
        if (typeof content !== 'string') throw new Error(`tool result must be a string: ${tool.name}`)
        const event: LLMEvent = {
          type: EventType.TOOL_CALL_RESULT,
          messageId: globalThis.crypto.randomUUID(),
          toolCallId: call.id,
          role: 'tool',
          content
        }
        assembly.apply(event)
        yield event
      }
    } else {
      for (const { call, tool, args } of executions) {
        signal.throwIfAborted()
        const content = await tool.execute(args, executionContext(call))
        signal.throwIfAborted()
        if (typeof content !== 'string') throw new Error(`tool result must be a string: ${tool.name}`)
        const event: LLMEvent = {
          type: EventType.TOOL_CALL_RESULT,
          messageId: globalThis.crypto.randomUUID(),
          toolCallId: call.id,
          role: 'tool',
          content
        }
        assembly.apply(event)
        yield event
      }
    }
    rounds++
    signal.throwIfAborted()
    current = {
      ...current,
      input: await prepareInput({ ...current.input, messages: [...current.input.messages, ...assembly.messages] })
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
