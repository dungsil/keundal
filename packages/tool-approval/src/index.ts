import { EventType, type AGUIEvent } from '@keundal/core'
import type { ToolOperation } from '@keundal/tools'

export const TOOL_APPROVAL_EVENT = 'keundal.tool.approval'
export type ToolPermission = 'allow' | 'ask' | 'deny'

export interface ToolApprovalPolicy {
  readonly default?: ToolPermission
  readonly tools?: Readonly<Record<string, ToolPermission>>
}

export interface ToolApprovalRequest {
  readonly requestId: string
  readonly threadId: string
  readonly runId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: Readonly<Record<string, unknown>>
  readonly operation: ToolOperation
}

export type ToolApprovalRecord = ToolApprovalRequest &
  (
    | { readonly status: 'requested'; readonly policy: 'ask' }
    | {
        readonly status: 'decided'
        readonly policy: ToolPermission
        readonly decision: 'allow' | 'deny'
        readonly source: 'policy' | 'user'
      }
  )

/** A host-owned approval queue. Journal replay never invokes this queue or an executor. */
export class ToolApproval {
  private readonly policy: ToolApprovalPolicy
  private readonly pending = new Map<
    string,
    {
      request: ToolApprovalRequest
      resolve: (decision: 'allow' | 'deny') => void
    }
  >()

  constructor(policy: ToolApprovalPolicy = {}) {
    if (
      !policy ||
      typeof policy !== 'object' ||
      Array.isArray(policy) ||
      Object.keys(policy).some((key) => key !== 'default' && key !== 'tools') ||
      (policy.tools !== undefined && (!policy.tools || typeof policy.tools !== 'object' || Array.isArray(policy.tools)))
    ) {
      throw new Error('invalid tool approval policy')
    }
    const values = [policy.default === undefined ? 'ask' : policy.default, ...Object.values(policy.tools ?? {})]
    if (values.some((value) => !['allow', 'ask', 'deny'].includes(value))) {
      throw new Error('tool permission must be allow, ask or deny')
    }
    this.policy = { default: policy.default ?? 'ask', tools: { ...policy.tools } }
  }

  /** Returns false for stale, duplicate, or incorrectly scoped replies. */
  respond(runId: string, requestId: string, decision: 'allow' | 'deny'): boolean {
    if (decision !== 'allow' && decision !== 'deny') throw new Error('invalid approval decision')
    const entry = this.pending.get(requestId)
    if (!entry || entry.request.runId !== runId) return false
    this.pending.delete(requestId)
    entry.resolve(decision)
    return true
  }

  async authorize(
    input: Omit<ToolApprovalRequest, 'requestId'>,
    signal: AbortSignal,
    record: (event: Extract<AGUIEvent, { type: 'CUSTOM' }>) => Promise<void>
  ): Promise<boolean> {
    signal.throwIfAborted()
    const request = globalThis.structuredClone({ ...input, requestId: globalThis.crypto.randomUUID() })
    const policy = Object.hasOwn(this.policy.tools!, request.toolName)
      ? this.policy.tools![request.toolName]!
      : this.policy.default!
    const publish = (value: ToolApprovalRecord) => record({ type: EventType.CUSTOM, name: TOOL_APPROVAL_EVENT, value })
    let decision: 'allow' | 'deny'
    if (policy === 'ask') {
      const response = Promise.withResolvers<'allow' | 'deny'>()
      // Cancellation resolves the local wait; throwIfAborted below prevents execution.
      const abort = () => {
        this.pending.delete(request.requestId)
        response.resolve('deny')
      }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(request.requestId, { request, resolve: response.resolve })
      try {
        await publish({ ...request, status: 'requested', policy })
        signal.throwIfAborted()
        decision = await response.promise
        signal.throwIfAborted()
      } finally {
        this.pending.delete(request.requestId)
        signal.removeEventListener('abort', abort)
      }
    } else {
      decision = policy
    }
    await publish({ ...request, status: 'decided', policy, decision, source: policy === 'ask' ? 'user' : 'policy' })
    signal.throwIfAborted()
    return decision === 'allow'
  }
}

export function isToolApprovalRecord(value: unknown): value is ToolApprovalRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  const operation = record.operation as ToolOperation | undefined
  return (
    ['requestId', 'threadId', 'runId', 'toolCallId', 'toolName'].every((key) => typeof record[key] === 'string') &&
    !!record.arguments &&
    typeof record.arguments === 'object' &&
    !Array.isArray(record.arguments) &&
    !!operation &&
    typeof operation.kind === 'string' &&
    (operation.command === undefined || typeof operation.command === 'string') &&
    (operation.paths === undefined ||
      (Array.isArray(operation.paths) && operation.paths.every((path) => typeof path === 'string'))) &&
    ((record.status === 'requested' && record.policy === 'ask') ||
      (record.status === 'decided' &&
        ['allow', 'ask', 'deny'].includes(String(record.policy)) &&
        (record.decision === 'allow' || record.decision === 'deny') &&
        (record.source === 'policy' || record.source === 'user')))
  )
}
