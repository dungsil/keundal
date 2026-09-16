import { EventType, type AGUIEvent, type AgentMessage, type GenerationJournalEntry } from '@keundal/core'

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>
type AssistantToolCall = NonNullable<AssistantMessage['toolCalls']>[number]

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

/** journal만으로 실행 결과 메시지를 다시 조립합니다. */
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
        if (!host || host.role !== 'assistant' || !host.toolCalls)
          throw new Error(`tool call arguments have no matching tool call: ${event.toolCallId}`)
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

export function recordJournal(entries: readonly GenerationJournalEntry[]): GenerationRecorder {
  const recorder = new GenerationRecorder()
  for (const entry of entries) recorder.record(entry.event)
  return recorder
}

function toolCall(id: string, name: string): AssistantToolCall {
  return { id, type: 'function', function: { name, arguments: '' } }
}
