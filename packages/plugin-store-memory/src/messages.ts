import { EventType, type AGUIEvent, type AgentMessage, type GenerationJournalEntry } from '@keundal/core'

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
 * 실행 이벤트를 journal과 메시지로 누적합니다. journal은 이벤트를 순서대로 보관하고, 메시지는
 * 어시스턴트 텍스트·도구 호출·추론 요약을 하나의 실행 결과로 조립합니다. 배열은 저장소가
 * 참조하므로 실행 중에도 부분 응답이 그대로 저장됩니다.
 */
export class GenerationRecorder {
  readonly journal: GenerationJournalEntry[] = []
  readonly messages: AgentMessage[] = []

  private readonly positions = new Map<string, number>()
  private readonly callHosts = new Map<string, string>()
  private open?: string

  record(event: AGUIEvent): void {
    this.journal.push({ sequence: this.journal.length, event })
    this.apply(event)
  }

  private apply(event: AGUIEvent): void {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START:
        this.open = event.messageId
        this.write({ id: event.messageId, role: 'assistant', content: '' })
        return
      case EventType.TEXT_MESSAGE_CONTENT:
        this.append(event.messageId, { id: event.messageId, role: 'assistant', content: '' }, event.delta)
        return
      case EventType.TOOL_CALL_START: {
        const host = this.host(event.toolCallId)
        this.write({ ...host, toolCalls: [...(host.toolCalls ?? []), toolCall(event.toolCallId, event.toolCallName)] })
        this.callHosts.set(event.toolCallId, host.id)
        return
      }
      case EventType.TOOL_CALL_ARGS: {
        const hostId = this.callHosts.get(event.toolCallId)
        const host = hostId === undefined ? undefined : this.message(hostId)
        if (!host || host.role !== 'assistant' || !host.toolCalls) {
          throw new Error(`tool call arguments have no matching tool call: ${event.toolCallId}`)
        }
        this.write({
          ...host,
          toolCalls: host.toolCalls.map((call) =>
            call.id === event.toolCallId
              ? { ...call, function: { ...call.function, arguments: call.function.arguments + event.delta } }
              : call
          )
        })
        return
      }
      case EventType.REASONING_MESSAGE_START:
        this.write({ id: event.messageId, role: 'reasoning', content: '' })
        return
      case EventType.REASONING_MESSAGE_CONTENT:
        this.append(event.messageId, { id: event.messageId, role: 'reasoning', content: '' }, event.delta)
        return
      case EventType.REASONING_ENCRYPTED_VALUE: {
        if (event.subtype !== 'message') return
        const message = this.message(event.entityId)
        if (message?.role === 'reasoning') this.write({ ...message, encryptedValue: event.encryptedValue })
        return
      }
      default:
        return
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

  private append(id: string, seed: AgentMessage, delta: string): void {
    if (!delta) return
    const existing = this.message(id)
    const content = existing && 'content' in existing && typeof existing.content === 'string' ? existing.content : ''
    const position = this.positions.get(id)
    if (position === undefined) this.write({ ...seed, content: delta } as AgentMessage)
    else this.messages[position] = { ...existing, content: content + delta } as AgentMessage
  }

  private write(message: AgentMessage): void {
    const position = this.positions.get(message.id)
    if (position === undefined) {
      this.positions.set(message.id, this.messages.length)
      this.messages.push(message)
    } else {
      this.messages[position] = message
    }
  }
}

function toolCall(id: string, name: string): AssistantToolCall {
  return { id, type: 'function', function: { name, arguments: '' } }
}
