import {
  CONTEXT_MESSAGE_EVENT,
  CONTEXT_MESSAGE_PREFIX,
  STEER_MESSAGE_EVENT,
  EventType,
  MessageAssembly,
  type LLMEvent,
  type LLMRequest,
  type LLMService,
  type AgentMessage,
  type RunAgentInput
} from '@keundal/core'
import type { ExecutableTool, ToolExecutionContext } from '@keundal/tools'
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
    steer?: () => AgentMessage[]
  } = {}
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
  /**
   * 다음 요청 입력을 준비하고, 준비 과정에서 새로 추가된 컨텍스트 메시지를 이벤트로 전달합니다.
   * 지시와 도구 결과가 같은 경로로 입력 예산과 축약 정책을 거치게 합니다.
   */
  const advance = async function* (messages: AgentMessage[]): AsyncGenerator<LLMEvent, RunAgentInput> {
    const next = { ...current.input, messages: [...current.input.messages, ...messages] }
    const prepared = await prepareInput(next)
    signal.throwIfAborted()
    const previousIds = new Set(next.messages.map((message) => message.id))
    for (const message of prepared.messages) {
      if (message.id.startsWith(CONTEXT_MESSAGE_PREFIX) && !previousIds.has(message.id)) {
        yield { type: EventType.CUSTOM, name: CONTEXT_MESSAGE_EVENT, value: message }
        signal.throwIfAborted()
      }
    }
    return prepared
  }
  /**
   * 대기 중인 지시를 꺼내 journal에 남깁니다. 이미 대화에 있는 id의 지시는 다시 넣지 않아, 같은
   * 지시를 재전송해도 한 번만 반영합니다.
   */
  const takeSteer = async function* (produced: readonly AgentMessage[]): AsyncGenerator<LLMEvent, AgentMessage[]> {
    const known = new Set([...current.input.messages, ...produced].map((message) => message.id))
    const accepted: AgentMessage[] = []
    for (const message of options.steer?.() ?? []) {
      if (known.has(message.id)) continue
      known.add(message.id)
      accepted.push(message)
      yield { type: EventType.CUSTOM, name: STEER_MESSAGE_EVENT, value: message }
      signal.throwIfAborted()
    }
    return accepted
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
    if (!calls.size) {
      // 도구 호출이 없는 응답 뒤에도 지시를 확인해, 실행을 끝내기 전에 다음 요청으로 반영합니다.
      // 반복 한도에 도달했으면 지시를 꺼내지 않고 남겨 호출자가 후속 실행으로 넘기게 합니다.
      if (rounds >= maxToolRounds) return
      const steered = yield* takeSteer(assembly.messages)
      if (!steered.length) return
      rounds++
      current = { ...current, input: yield* advance([...assembly.messages, ...steered]) }
      continue
    }
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
    // 지시는 진행 중인 요청이나 도구를 중단하지 않고, 완료된 도구 결과 뒤의 경계에서만 반영합니다.
    const steered = yield* takeSteer(assembly.messages)
    current = { ...current, input: yield* advance([...assembly.messages, ...steered]) }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
