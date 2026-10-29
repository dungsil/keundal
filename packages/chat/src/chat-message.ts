import {
  EventType,
  EventNormalizer,
  MessageAssembly,
  STEER_MESSAGE_EVENT,
  isSteerMessage,
  prepareReplayMessages,
  type AGUIEvent,
  type AgentMessage
} from '@keundal/core'
import { LLM_SOURCE_EVENT, type LLMSource } from '@keundal/llm'
import { TOOL_APPROVAL_EVENT, isToolApprovalRecord, type ToolApprovalRecord } from '@keundal/tool-approval'
import { TOOL_PROGRESS_EVENT } from '@keundal/tools'

import type { StoredAttachment } from './file'

export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'
export type TextPart =
  | { type: 'text'; text: string; state?: 'streaming' | 'done'; role?: 'user' | 'system' | 'developer' | 'assistant' }
  | { type: 'reasoning'; text: string; state?: 'streaming' | 'done' }
export type FilePart = StoredAttachment
export type ToolInvocation<T extends { input: unknown; output: unknown } = { input: unknown; output: unknown }> = {
  toolCallId: string
} & (
  | { state: 'input-streaming'; input?: Partial<T['input']>; output?: never }
  | { state: 'input-available'; input: T['input']; output?: never }
  | { state: 'output-available'; input: T['input']; output: T['output'] }
  | { state: 'output-error'; input?: T['input']; output?: never; errorText: string }
)
export type SubagentProgress = {
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  threadId?: string
  runId?: string
  label?: string
  error?: string
}
export type ToolPart = ToolInvocation & {
  type: `tool-${string}`
  providerExecuted?: boolean
  subagent?: SubagentProgress
  approvals?: ToolApprovalRecord[]
}
export type StatePart = { type: 'data-state'; data: unknown }
export type ActivityPart = {
  type: 'activity'
  messageId: string
  activityType: string
  content: Record<string, unknown>
}
export type ChatPart =
  | TextPart
  | FilePart
  | ToolPart
  | StatePart
  | ActivityPart
  | { type: 'data-state-warning'; message: string }
  | { type: 'source-url'; sourceId: string; url: string; title?: string }
  | { type: 'data-keundal'; data: { model: string; messages: AgentMessage[] } }

/** Presentation state owned by the web app, not a provider or transport protocol. */
export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  parts: ChatPart[]
  /**
   * 실행 중에 지시로 반영된 사용자 메시지는 반영한 실행 id를 가집니다. 모델 입력은 그 실행의
   * 어시스턴트 기록이 원래 위치로 다시 조립하므로, 이 메시지는 화면 표시에만 사용합니다.
   */
  metadata?: { steeredRunId?: string }
}

/** Projects native AG-UI events into the existing chat components and durable replay. */
export class ChatMessageAssembly {
  readonly message: ChatMessage
  /** 이 실행이 journal에 반영한 지시입니다. 반영한 순서를 유지합니다. */
  readonly steered: Extract<AgentMessage, { role: 'user' }>[] = []
  private readonly assembly: MessageAssembly
  private readonly normalizer = new EventNormalizer()
  private readonly texts = new Map<string, TextPart>()
  private readonly calls = new Map<string, { args: string; part: ToolPart }>()
  private readonly sources = new Set<string>()
  private search?: ToolPart & { state: 'output-available'; output: LLMSource[] }
  private statePart?: StatePart
  private readonly activities = new Map<string, ActivityPart>()

  constructor(id: string, initialState: unknown = {}) {
    this.assembly = new MessageAssembly(initialState)
    this.message = { id, role: 'assistant', parts: [] }
  }

  apply(event: AGUIEvent) {
    for (const normalized of this.normalizer.apply(event)) this.applyEvent(normalized)
  }

  private applyEvent(event: AGUIEvent) {
    const warningCount = this.assembly.warnings.length
    const changed = this.assembly.apply(event)
    for (const message of this.assembly.warnings.slice(warningCount))
      this.message.parts.push({ type: 'data-state-warning', message })
    if (event.type === EventType.CUSTOM && event.name === STEER_MESSAGE_EVENT && isSteerMessage(event.value)) {
      this.steered.push(event.value)
      return
    }
    switch (event.type) {
      case EventType.STATE_SNAPSHOT:
      case EventType.STATE_DELTA:
        if (this.assembly.warnings.length !== warningCount) break
        if (!this.statePart) {
          this.statePart = { type: 'data-state', data: this.assembly.state }
          this.message.parts.push(this.statePart)
        } else this.statePart.data = this.assembly.state
        break
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA: {
        if (changed?.role !== 'activity') break
        const part = this.activities.get(changed.id)
        if (part) Object.assign(part, { activityType: changed.activityType, content: changed.content })
        else {
          const created: ActivityPart = {
            type: 'activity',
            messageId: changed.id,
            activityType: changed.activityType,
            content: changed.content
          }
          this.activities.set(changed.id, created)
          this.message.parts.push(created)
        }
        break
      }
      case EventType.TEXT_MESSAGE_START:
      case EventType.REASONING_MESSAGE_START: {
        const part: TextPart = {
          type: event.type === EventType.TEXT_MESSAGE_START ? 'text' : 'reasoning',
          text: '',
          state: 'streaming',
          ...(event.type === EventType.TEXT_MESSAGE_START && event.role && event.role !== 'assistant'
            ? { role: event.role }
            : {})
        }
        this.texts.set(event.messageId, part)
        this.message.parts.push(part)
        break
      }
      case EventType.TEXT_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CONTENT:
        this.texts.get(event.messageId)!.text += event.delta
        break
      case EventType.TEXT_MESSAGE_END:
      case EventType.REASONING_MESSAGE_END: {
        delete this.texts.get(event.messageId)!.state
        const blocks = event.metadata?.['openai.outputItems'] ?? event.metadata?.['anthropic.contentBlocks']
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type !== 'web_search_call' && !(block.type === 'server_tool_use' && block.name === 'web_search'))
              continue
            const query =
              block.type === 'web_search_call'
                ? (block.action?.query ?? block.action?.queries?.join(' '))
                : block.input?.query
            this.search = {
              type: 'tool-web_search',
              toolCallId: block.id,
              state: 'output-available',
              input: { query },
              output: [],
              providerExecuted: true
            }
            this.message.parts.push(this.search)
          }
        }
        break
      }
      case EventType.TOOL_CALL_START: {
        const part: ToolPart = {
          type: `tool-${event.toolCallName}`,
          toolCallId: event.toolCallId,
          state: 'input-streaming'
        }
        this.calls.set(event.toolCallId, { args: '', part })
        this.message.parts.push(part)
        break
      }
      case EventType.TOOL_CALL_ARGS:
        this.calls.get(event.toolCallId)!.args += event.delta
        break
      case EventType.TOOL_CALL_END: {
        const call = this.calls.get(event.toolCallId)!
        Object.assign(call.part, { state: 'input-available', input: JSON.parse(call.args) })
        break
      }
      case EventType.TOOL_CALL_RESULT: {
        const { part } = this.calls.get(event.toolCallId)!
        let output: unknown = event.content
        if (part.type !== 'tool-skill' && typeof event.content === 'string') {
          try {
            output = JSON.parse(event.content)
          } catch {
            output = event.content
          }
        }
        Object.assign(part, { state: 'output-available', output })
        if (part.type === 'tool-delegate_task' && output && typeof output === 'object' && 'status' in output) {
          if (output.status === 'completed' || output.status === 'failed' || output.status === 'rejected') {
            part.subagent = { ...part.subagent, status: output.status === 'completed' ? 'completed' : 'failed' }
          }
        }
        break
      }
      case EventType.CUSTOM:
        if (event.name === TOOL_APPROVAL_EVENT && isToolApprovalRecord(event.value)) {
          const part = this.calls.get(event.value.toolCallId)?.part
          if (part && part.type === `tool-${event.value.toolName}`) this.applyApproval(part, event.value)
        }
        if (event.name === TOOL_PROGRESS_EVENT) {
          const payload = event.value
          if (payload && typeof payload === 'object' && typeof payload.toolCallId === 'string') {
            const part = this.calls.get(payload.toolCallId)?.part
            const progress = payload.value
            if (
              part?.type === 'tool-delegate_task' &&
              progress &&
              typeof progress === 'object' &&
              isToolApprovalRecord(progress.approval)
            ) {
              this.applyApproval(part, progress.approval)
            }
            if (
              part?.type === 'tool-delegate_task' &&
              progress &&
              typeof progress === 'object' &&
              ['running', 'completed', 'failed', 'cancelled'].includes(progress.status) &&
              (progress.threadId === undefined || typeof progress.threadId === 'string') &&
              (progress.runId === undefined || typeof progress.runId === 'string') &&
              (progress.label === undefined || typeof progress.label === 'string') &&
              (progress.error === undefined || typeof progress.error === 'string')
            ) {
              part.subagent = {
                status: progress.status,
                threadId: progress.threadId,
                runId: progress.runId,
                label: progress.label,
                error: progress.error
              }
            }
          }
        }
        if (event.name === LLM_SOURCE_EVENT) {
          const source = event.value as LLMSource
          if (!this.sources.has(source.id)) {
            this.sources.add(source.id)
            this.message.parts.push({ type: 'source-url', sourceId: source.id, url: source.url, title: source.title })
            this.search?.output.push(source)
          }
        }
        break
    }
  }

  private applyApproval(part: ToolPart, record: ToolApprovalRecord) {
    part.approvals ??= []
    const index = part.approvals.findIndex((entry) => entry.requestId === record.requestId)
    if (index === -1) part.approvals.push(record)
    else part.approvals[index] = record
  }

  finish(model: string) {
    // Interrupted text must not remain animated. Only complete calls and signed
    // reasoning can be replayed to a provider on the next turn.
    for (const part of this.texts.values()) delete part.state
    for (const { part } of this.calls.values()) {
      if (part.subagent?.status === 'running') part.subagent.status = 'cancelled'
      if (part.state !== 'output-available')
        Object.assign(part, { state: 'output-error', errorText: 'Tool execution interrupted' })
    }
    const messages = prepareReplayMessages(this.assembly.messages, model, model)
    this.message.parts.push({ type: 'data-keundal', data: { model, messages } })
  }
}
