import { EventType, type AGUIEvent, type AgentMessage } from './protocol.js'

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>
type AssistantToolCall = NonNullable<AssistantMessage['toolCalls']>[number]

/**
 * 저장된 대화와 새 메시지를 하나의 대화로 병합합니다. 저장된 순서를 유지하고, 같은 id의 새
 * 메시지는 저장된 위치를 대체하므로 재전송된 요청이 중복으로 쌓이지 않습니다.
 */
export function mergeMessages(stored: readonly AgentMessage[], incoming: readonly AgentMessage[]): AgentMessage[] {
  const merged: AgentMessage[] = []
  const positions = new Map<string, number>()
  for (const message of stored) {
    positions.set(message.id, merged.length)
    merged.push(message)
  }
  for (const message of incoming) {
    const position = positions.get(message.id)
    if (position === undefined) {
      positions.set(message.id, merged.length)
      merged.push(message)
    } else {
      merged[position] = message
    }
  }
  return merged
}

/**
 * 실행 이벤트를 실행 메시지로 조립합니다. 어시스턴트 텍스트·도구 호출·추론 요약을 하나의 실행
 * 결과로 모으므로, 저장소 구현은 실행 이벤트마다 apply()가 돌려주는 메시지를 저장하면 됩니다.
 */
export class MessageAssembly {
  /** 조립한 순서대로의 실행 메시지입니다. */
  readonly messages: AgentMessage[] = []

  /** 메시지 id별 위치입니다. 같은 id를 다시 쓰면 저장된 위치를 대체합니다. */
  private readonly positions = new Map<string, number>()
  /** 도구 호출 id별로 인자를 붙일 어시스턴트 메시지 id입니다. */
  private readonly callHosts = new Map<string, string>()
  /** 도구 호출을 붙일 열린 메시지 id입니다. */
  private open?: string

  /** 이벤트를 조립에 반영하고, 바뀐 메시지를 돌려줍니다. 메시지를 만들지 않는 이벤트는 undefined입니다. */
  apply(event: AGUIEvent): AgentMessage | undefined {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        this.open = event.messageId
        return this.write({
          id: event.messageId,
          role: 'assistant',
          content: '',
          ...(event.metadata === undefined ? {} : { metadata: event.metadata })
        })
      case EventType.TEXT_MESSAGE_CONTENT:
        return this.append(event.messageId, { id: event.messageId, role: 'assistant', content: '' }, event.delta)
      case EventType.TEXT_MESSAGE_END: {
        const message = this.message(event.messageId)
        if (!message || event.metadata === undefined) return undefined
        return this.write({ ...message, metadata: { ...message.metadata, ...event.metadata } })
      }
      case EventType.TOOL_CALL_START: {
        const host = this.host(event.toolCallId)
        this.callHosts.set(event.toolCallId, host.id)
        return this.write({
          ...host,
          toolCalls: [...(host.toolCalls ?? []), toolCall(event.toolCallId, event.toolCallName)]
        })
      }
      case EventType.TOOL_CALL_ARGS: {
        const hostId = this.callHosts.get(event.toolCallId)
        const host = hostId === undefined ? undefined : this.message(hostId)
        if (!host || host.role !== 'assistant' || !host.toolCalls) {
          throw new Error(`tool call arguments have no matching tool call: ${event.toolCallId}`)
        }
        return this.write({
          ...host,
          toolCalls: host.toolCalls.map((call) =>
            call.id === event.toolCallId
              ? { ...call, function: { ...call.function, arguments: call.function.arguments + event.delta } }
              : call
          )
        })
      }
      case EventType.TOOL_CALL_RESULT:
        this.open = undefined
        return this.write({
          id: event.messageId,
          role: 'tool',
          toolCallId: event.toolCallId,
          content: event.content
        })
      case EventType.REASONING_MESSAGE_START:
        return this.write({ id: event.messageId, role: 'reasoning', content: '' })
      case EventType.REASONING_MESSAGE_CONTENT:
        return this.append(event.messageId, { id: event.messageId, role: 'reasoning', content: '' }, event.delta)
      case EventType.REASONING_ENCRYPTED_VALUE: {
        if (event.subtype === 'tool-call') {
          const hostId = this.callHosts.get(event.entityId)
          const host = hostId === undefined ? undefined : this.message(hostId)
          if (host?.role !== 'assistant' || !host.toolCalls) return undefined
          return this.write({
            ...host,
            toolCalls: host.toolCalls.map((call) =>
              call.id === event.entityId ? { ...call, encryptedValue: event.encryptedValue } : call
            )
          })
        }
        if (event.subtype !== 'message') return undefined
        const message = this.message(event.entityId)
        if (message?.role !== 'reasoning') return undefined
        return this.write({ ...message, encryptedValue: event.encryptedValue })
      }
      default:
        return undefined
    }
  }

  /** 도구 호출을 붙일 어시스턴트 메시지입니다. 열린 메시지가 없으면 도구 전용 메시지를 만듭니다. */
  private host(toolCallId: string): AssistantMessage {
    const open = this.open === undefined ? undefined : this.message(this.open)
    if (open?.role === 'assistant') return open
    const created: AssistantMessage = { id: toolCallId, role: 'assistant', toolCalls: [] }
    this.write(created)
    this.open = created.id
    return created
  }

  private message(id: string): AgentMessage | undefined {
    const position = this.positions.get(id)
    return position === undefined ? undefined : this.messages[position]
  }

  private append(id: string, seed: AgentMessage, delta: string): AgentMessage | undefined {
    if (!delta) return undefined
    const existing = this.message(id)
    const content = existing && 'content' in existing && typeof existing.content === 'string' ? existing.content : ''
    return this.write({ ...(existing ?? seed), content: content + delta } as AgentMessage)
  }

  private write(message: AgentMessage): AgentMessage {
    const position = this.positions.get(message.id)
    if (position === undefined) {
      this.positions.set(message.id, this.messages.length)
      this.messages.push(message)
    } else {
      this.messages[position] = message
    }
    return message
  }
}

function toolCall(id: string, name: string): AssistantToolCall {
  return { id, type: 'function', function: { name, arguments: '' } }
}
