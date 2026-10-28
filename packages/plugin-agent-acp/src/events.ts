import type { SessionNotification } from '@agentclientprotocol/sdk'
import { EventType } from '@keundal/core'
import type { LLMEvent } from '@keundal/llm'

export const ACP_UPDATE_EVENT = 'keundal.acp.update'

/** One translator per turn: ACP identifiers are session-scoped, AG-UI identifiers are not. */
export class AcpEvents {
  private open?: { id: string; source?: string | null; reasoning: boolean }
  private readonly tools = new Map<string, { id: string; ended: boolean; result: boolean }>()

  toolCallId(source: string): string {
    return this.tools.get(source)!.id
  }

  *end(): Generator<LLMEvent> {
    if (!this.open) return
    const { id, reasoning } = this.open
    this.open = undefined
    if (reasoning) {
      yield { type: EventType.REASONING_MESSAGE_END, messageId: id }
      yield { type: EventType.REASONING_END, messageId: id }
    } else yield { type: EventType.TEXT_MESSAGE_END, messageId: id }
  }

  *update(notification: SessionNotification): Generator<LLMEvent> {
    const update = notification.update
    // Preserve plans, diffs, usage and future ACP updates without inventing AG-UI semantics.
    yield { type: EventType.CUSTOM, name: ACP_UPDATE_EVENT, value: notification }
    if (update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      if (update.content.type !== 'text' || !update.content.text) return
      const reasoning = update.sessionUpdate === 'agent_thought_chunk'
      if (!this.open || this.open.reasoning !== reasoning || this.open.source !== update.messageId) {
        yield* this.end()
        const id = globalThis.crypto.randomUUID()
        this.open = { id, source: update.messageId, reasoning }
        if (reasoning) {
          yield { type: EventType.REASONING_START, messageId: id }
          yield { type: EventType.REASONING_MESSAGE_START, messageId: id, role: 'reasoning' }
        } else yield { type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }
      }
      yield {
        type: reasoning ? EventType.REASONING_MESSAGE_CONTENT : EventType.TEXT_MESSAGE_CONTENT,
        messageId: this.open.id,
        delta: update.content.text
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      yield* this.end()
      let tool = this.tools.get(update.toolCallId)
      if (!tool) {
        tool = { id: globalThis.crypto.randomUUID(), ended: false, result: false }
        this.tools.set(update.toolCallId, tool)
        yield {
          type: EventType.TOOL_CALL_START,
          toolCallId: tool.id,
          toolCallName: update.name ?? update.title ?? update.toolCallId
        }
      }
      // ACP rawInput updates replace the input; AG-UI args append. Emit only the final snapshot.
      if (!tool.ended && update.rawInput !== undefined) {
        // Save the latest input until the tool finishes.
        this.inputs.set(update.toolCallId, update.rawInput)
      }
      if (update.status === 'completed' || update.status === 'failed') {
        if (!tool.ended) {
          yield {
            type: EventType.TOOL_CALL_ARGS,
            toolCallId: tool.id,
            delta: JSON.stringify(this.inputs.get(update.toolCallId) ?? {})
          }
          yield { type: EventType.TOOL_CALL_END, toolCallId: tool.id }
          tool.ended = true
        }
        if (!tool.result) {
          yield {
            type: EventType.TOOL_CALL_RESULT,
            toolCallId: tool.id,
            messageId: globalThis.crypto.randomUUID(),
            role: 'tool',
            content: JSON.stringify(update.rawOutput ?? update.content ?? { status: update.status })
          }
          tool.result = true
        }
      }
    }
  }

  private readonly inputs = new Map<string, unknown>()
}
