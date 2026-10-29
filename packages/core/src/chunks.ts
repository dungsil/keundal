import { EventType, type AGUIEvent } from './protocol.js'

type Chunk = Extract<AGUIEvent, { type: 'TEXT_MESSAGE_CHUNK' | 'REASONING_MESSAGE_CHUNK' | 'TOOL_CALL_CHUNK' }>
type ExpandedChunk = Extract<
  AGUIEvent,
  {
    type:
      | 'TEXT_MESSAGE_START'
      | 'TEXT_MESSAGE_CONTENT'
      | 'TEXT_MESSAGE_END'
      | 'REASONING_MESSAGE_START'
      | 'REASONING_MESSAGE_CONTENT'
      | 'REASONING_MESSAGE_END'
      | 'TOOL_CALL_START'
      | 'TOOL_CALL_ARGS'
      | 'TOOL_CALL_END'
  }
>
type Pending = { chunk: Chunk; id: string; owner?: string }

/** Expands chunk shorthand without treating a transport disconnect as message completion. */
export class EventNormalizer {
  private readonly lanes = new Map<string | undefined, Pending>()

  finish(): ExpandedChunk[] {
    return [...this.lanes.keys()].flatMap((owner) => this.close(owner))
  }

  private close(owner: string | undefined): ExpandedChunk[] {
    const pending = this.lanes.get(owner)
    if (!pending) return []
    this.lanes.delete(owner)
    const attribution = owner === undefined ? {} : { subagentRunId: owner }
    switch (pending.chunk.type) {
      case EventType.TEXT_MESSAGE_CHUNK:
        return [{ type: EventType.TEXT_MESSAGE_END, messageId: pending.id, ...attribution }]
      case EventType.REASONING_MESSAGE_CHUNK:
        return [{ type: EventType.REASONING_MESSAGE_END, messageId: pending.id, ...attribution }]
      case EventType.TOOL_CALL_CHUNK:
        return [{ type: EventType.TOOL_CALL_END, toolCallId: pending.id, ...attribution }]
    }
  }

  apply<T extends AGUIEvent>(event: T): (Exclude<T, Chunk> | ExpandedChunk)[]
  apply(event: AGUIEvent): AGUIEvent[] {
    switch (event.type) {
      case EventType.RUN_STARTED:
      case EventType.RUN_FINISHED:
      case EventType.RUN_ERROR:
      case EventType.MESSAGES_SNAPSHOT:
        return [...this.finish(), event]
      case EventType.RAW:
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA:
      case EventType.REASONING_ENCRYPTED_VALUE:
      case EventType.SUBAGENT_STARTED:
        return [event]
      case EventType.SUBAGENT_FINISHED:
      case EventType.SUBAGENT_ERROR:
        return [...this.close(event.subagentRunId), event]
      case EventType.TEXT_MESSAGE_CHUNK:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.TOOL_CALL_CHUNK:
        return this.expand(event)
      default:
        return [...this.close('subagentRunId' in event ? event.subagentRunId : undefined), event]
    }
  }

  private expand(chunk: Chunk): AGUIEvent[] {
    const id = chunk.type === EventType.TOOL_CALL_CHUNK ? chunk.toolCallId : chunk.messageId
    let owner = chunk.subagentRunId
    const candidates = [...this.lanes.values()].filter((p) => p.chunk.type === chunk.type)
    const named = id === undefined ? undefined : candidates.find((p) => p.id === id)
    if (named) {
      if (owner !== undefined && owner !== named.owner) throw new Error('chunk changes its open stream owner')
      owner = named.owner
    } else if (id === undefined && owner === undefined && this.lanes.get(undefined)?.chunk.type !== chunk.type) {
      if (candidates.length > 1) throw new Error('ambiguous chunk continuation')
      owner = candidates[0]?.owner
    }
    let pending = this.lanes.get(owner)
    const result: AGUIEvent[] = []
    const attribution = owner === undefined ? {} : { subagentRunId: owner }
    const metadata = chunk.metadata === undefined ? {} : { metadata: chunk.metadata }
    if (pending?.chunk.type !== chunk.type || (id !== undefined && id !== pending.id)) {
      if (id === undefined) throw new Error(`first ${chunk.type} requires an id`)
      result.push(...this.close(owner))
      switch (chunk.type) {
        case EventType.TEXT_MESSAGE_CHUNK:
          result.push({
            type: EventType.TEXT_MESSAGE_START,
            messageId: id,
            role: chunk.role ?? 'assistant',
            ...(chunk.name === undefined ? {} : { name: chunk.name }),
            ...attribution,
            ...metadata
          })
          break
        case EventType.REASONING_MESSAGE_CHUNK:
          result.push({
            type: EventType.REASONING_MESSAGE_START,
            messageId: id,
            role: 'reasoning',
            ...attribution,
            ...metadata
          })
          break
        case EventType.TOOL_CALL_CHUNK:
          if (chunk.toolCallName === undefined) throw new Error('first TOOL_CALL_CHUNK requires a toolCallName')
          result.push({
            type: EventType.TOOL_CALL_START,
            toolCallId: id,
            toolCallName: chunk.toolCallName,
            ...(chunk.parentMessageId === undefined ? {} : { parentMessageId: chunk.parentMessageId }),
            ...attribution,
            ...metadata
          })
          break
      }
      pending = { chunk, id, owner }
      this.lanes.set(owner, pending)
    } else {
      if (chunk.type === EventType.TEXT_MESSAGE_CHUNK && pending.chunk.type === chunk.type) {
        if (
          (chunk.role !== undefined && chunk.role !== (pending.chunk.role ?? 'assistant')) ||
          (chunk.name !== undefined && chunk.name !== pending.chunk.name)
        )
          throw new Error('chunk changes its open text message')
      }
      if (chunk.type === EventType.TOOL_CALL_CHUNK && pending.chunk.type === chunk.type) {
        if (
          (chunk.toolCallName !== undefined && chunk.toolCallName !== pending.chunk.toolCallName) ||
          (chunk.parentMessageId !== undefined && chunk.parentMessageId !== pending.chunk.parentMessageId)
        )
          throw new Error('chunk changes its open tool call')
      }
    }
    if (chunk.delta !== undefined || chunk.metadata !== undefined || chunk.rawEvent !== undefined) {
      const origin = {
        ...attribution,
        ...metadata,
        ...(chunk.rawEvent === undefined ? {} : { rawEvent: chunk.rawEvent }),
        ...(chunk.timestamp === undefined ? {} : { timestamp: chunk.timestamp })
      }
      switch (chunk.type) {
        case EventType.TEXT_MESSAGE_CHUNK:
          result.push({
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: pending.id,
            delta: chunk.delta ?? '',
            ...origin
          })
          break
        case EventType.REASONING_MESSAGE_CHUNK:
          result.push({
            type: EventType.REASONING_MESSAGE_CONTENT,
            messageId: pending.id,
            delta: chunk.delta ?? '',
            ...origin
          })
          break
        case EventType.TOOL_CALL_CHUNK:
          result.push({ type: EventType.TOOL_CALL_ARGS, toolCallId: pending.id, delta: chunk.delta ?? '', ...origin })
          break
      }
    }
    return result
  }
}

/** Use at a producer boundary: only normal source completion closes pending chunks. */
export async function* normalizeEvents<T extends AGUIEvent>(
  events: AsyncIterable<T>
): AsyncGenerator<Exclude<T, Chunk> | ExpandedChunk> {
  const normalizer = new EventNormalizer()
  for await (const event of events) yield* normalizer.apply(event)
  yield* normalizer.finish()
}
