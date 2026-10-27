import { EventType, type AGUIEvent, type AgentMessage } from './protocol.js'

type AssistantMessage = Extract<AgentMessage, { role: 'assistant' }>
type AssistantToolCall = NonNullable<AssistantMessage['toolCalls']>[number]

export const CONTEXT_MESSAGE_PREFIX = 'keundal:context:'
export const CONTEXT_MESSAGE_EVENT = 'keundal.context.message'
/**
 * 실행 중에 반영한 사용자 지시를 journal에 남기는 AG-UI CUSTOM 이벤트 이름입니다. value는 사용자
 * 메시지이며, 재생과 복구는 이 기록으로 지시를 원래 위치에 다시 조립합니다.
 */
export const STEER_MESSAGE_EVENT = 'keundal.steer.message'

type UserMessage = Extract<AgentMessage, { role: 'user' }>

/** 지시 이벤트의 값이 사용자 메시지인지 확인합니다. */
export function isSteerMessage(value: unknown): value is UserMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    'role' in value &&
    value.role === 'user' &&
    'content' in value &&
    (typeof value.content === 'string' || Array.isArray(value.content))
  )
}

/** 결과 없는 도구 호출과 서명 없는 추론을 제외합니다. 모델을 바꾸면 공급자 전용 상태도 제거합니다. */
export function prepareReplayMessages(
  messages: readonly AgentMessage[],
  sourceModel: string,
  targetModel: string
): AgentMessage[] {
  const sameModel = sourceModel === targetModel
  const results = new Set(messages.flatMap((message) => (message.role === 'tool' ? [message.toolCallId] : [])))
  return messages
    .filter((message) => message.role !== 'reasoning' || (sameModel && !!message.encryptedValue))
    .map((message) => {
      if (message.role !== 'assistant') return message
      const toolCalls = message.toolCalls?.filter((call) => results.has(call.id))
      if (sameModel) return { ...message, toolCalls }
      return {
        ...message,
        metadata: undefined,
        toolCalls: toolCalls?.map(({ encryptedValue: _value, ...call }) => call)
      }
    })
}

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
      case EventType.CUSTOM: {
        if (event.name === STEER_MESSAGE_EVENT) {
          if (!isSteerMessage(event.value)) throw new Error('invalid steer message event')
          this.open = undefined
          return this.write(event.value)
        }
        if (event.name !== CONTEXT_MESSAGE_EVENT) return undefined
        const value: unknown = event.value
        if (
          typeof value !== 'object' ||
          value === null ||
          !('id' in value) ||
          typeof value.id !== 'string' ||
          !value.id.startsWith(CONTEXT_MESSAGE_PREFIX) ||
          !('role' in value) ||
          value.role !== 'user' ||
          !('content' in value) ||
          typeof value.content !== 'string'
        )
          throw new Error('invalid context message event')
        this.open = undefined
        return this.write({ id: value.id, role: 'user', content: value.content })
      }
      case EventType.TEXT_MESSAGE_START: {
        const existing = this.message(event.messageId)
        const message = existing?.role === 'assistant' ? existing : undefined
        this.open = event.messageId
        return this.write({
          ...message,
          id: event.messageId,
          role: 'assistant',
          content: message?.content ?? '',
          ...(event.metadata === undefined ? {} : { metadata: { ...message?.metadata, ...event.metadata } })
        })
      }
      case EventType.TEXT_MESSAGE_CONTENT:
        return this.append(event.messageId, { id: event.messageId, role: 'assistant', content: '' }, event.delta)
      case EventType.TEXT_MESSAGE_END: {
        const message = this.message(event.messageId)
        if (!message || event.metadata === undefined) return undefined
        return this.write({ ...message, metadata: { ...message.metadata, ...event.metadata } })
      }
      case EventType.TOOL_CALL_START: {
        const host = this.host(event.toolCallId, event.parentMessageId)
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

  /** 명시한 부모를 우선하며, 부모가 없으면 열린 메시지나 도구 전용 메시지를 사용합니다. */
  private host(toolCallId: string, parentMessageId?: string): AssistantMessage {
    if (parentMessageId !== undefined) {
      const parent = this.message(parentMessageId)
      if (parent !== undefined && parent.role !== 'assistant') {
        throw new Error(`tool call parent is not an assistant message: ${parentMessageId}`)
      }
      return parent ?? { id: parentMessageId, role: 'assistant', toolCalls: [] }
    }
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
