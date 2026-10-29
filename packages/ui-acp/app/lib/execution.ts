import type { PlanEntry, ToolCallUpdate, UsageUpdate } from '@agentclientprotocol/sdk'
import { EventType, type AGUIEvent } from '@keundal/core'
import type { GenerationStatus } from '@keundal/generation'
import { z } from 'zod'

export interface AcpTool extends ToolCallUpdate {
  toolCallId: string
  aguiToolCallId?: string
}

export interface AcpExecution {
  sessionId?: string
  plan: PlanEntry[]
  tools: Map<string, AcpTool>
  usage?: UsageUpdate
  status: GenerationStatus
  pendingToolId?: string
}

// Keep the SDK type-only: its runtime entry point imports Node transports.
// Validate known v1 payloads locally, without accepting malformed known variants
// as future protocol extensions or letting unknown fields overwrite projection data.
const metadata = { _meta: z.record(z.string(), z.unknown()).nullish() }
const annotations = z.object({
  ...metadata,
  audience: z.array(z.enum(['assistant', 'user'])).nullish(),
  lastModified: z.string().nullish(),
  priority: z.number().nullish()
})
const annotated = { ...metadata, annotations: annotations.nullish() }
const textContent = z.object({ ...annotated, type: z.literal('text'), text: z.string() })
const resource = { ...metadata, uri: z.string(), mimeType: z.string().nullish() }
const contentBlock = z.discriminatedUnion('type', [
  textContent,
  z.object({
    ...annotated,
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
    uri: z.string().nullish()
  }),
  z.object({ ...annotated, type: z.literal('audio'), data: z.string(), mimeType: z.string() }),
  z.object({
    ...annotated,
    type: z.literal('resource_link'),
    name: z.string(),
    uri: z.string(),
    description: z.string().nullish(),
    mimeType: z.string().nullish(),
    size: z.number().int().nullish(),
    title: z.string().nullish()
  }),
  z.object({
    ...annotated,
    type: z.literal('resource'),
    resource: z.union([
      z.object({ ...resource, text: z.string() }),
      z.object({ ...resource, blob: z.string() })
    ])
  })
])
const toolContent = z.discriminatedUnion('type', [
  z.object({ ...metadata, type: z.literal('content'), content: contentBlock }),
  z.object({
    ...metadata,
    type: z.literal('diff'),
    path: z.string(),
    oldText: z.string().nullish(),
    newText: z.string()
  }),
  z.object({ ...metadata, type: z.literal('terminal'), terminalId: z.string() })
])
const locations = z.array(z.object({
  ...metadata,
  path: z.string(),
  line: z.number().int().min(0).max(4294967295).nullish()
}))
const kind = z.enum(['read', 'edit', 'delete', 'move', 'search', 'execute', 'think', 'fetch', 'switch_mode', 'other'])
const toolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed'])
const toolFields = {
  ...metadata,
  toolCallId: z.string(),
  name: z.string().nullish(),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional()
}
const notification = z.object({
  ...metadata,
  sessionId: z.string(),
  update: z.discriminatedUnion('sessionUpdate', [
    z.object({
      ...metadata,
      sessionUpdate: z.literal('plan'),
      entries: z.array(z.object({
        ...metadata,
        content: z.string(),
        priority: z.enum(['high', 'medium', 'low']),
        status: z.enum(['pending', 'in_progress', 'completed'])
      }))
    }),
    z.object({
      ...toolFields,
      sessionUpdate: z.literal('tool_call'),
      title: z.string(),
      kind: kind.optional(),
      status: toolStatus.optional(),
      content: z.array(toolContent).optional(),
      locations: locations.optional()
    }),
    z.object({
      ...toolFields,
      sessionUpdate: z.literal('tool_call_update'),
      title: z.string().nullish(),
      kind: kind.nullish(),
      status: toolStatus.nullish(),
      content: z.array(toolContent).nullish(),
      locations: locations.nullish()
    }),
    z.object({
      ...metadata,
      sessionUpdate: z.literal('usage_update'),
      used: z.number().int().nonnegative(),
      size: z.number().int().nonnegative(),
      cost: z.object({ ...metadata, amount: z.number(), currency: z.string() }).nullish()
    }),
    // Text-only ACP turns still need an identity, but have no execution payload.
    z.object({
      ...metadata,
      sessionUpdate: z.enum(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk']),
      content: textContent,
      messageId: z.string().nullish()
    })
  ])
})

export function createExecution(): AcpExecution {
  return { plan: [], tools: new Map(), status: 'running' }
}

export function applyExecutionEvent(state: AcpExecution, event: AGUIEvent): void {
  if (event.type === EventType.TOOL_CALL_START) {
    const tool = state.pendingToolId === undefined ? undefined : state.tools.get(state.pendingToolId)
    if (tool && tool.aguiToolCallId === undefined) tool.aguiToolCallId = event.toolCallId
    delete state.pendingToolId
    return
  }

  // The translator can close an open text/reasoning message between the custom
  // notification and its TOOL_CALL_START. No other event can claim this pairing.
  if (event.type !== EventType.TEXT_MESSAGE_END &&
      event.type !== EventType.REASONING_MESSAGE_END &&
      event.type !== EventType.REASONING_END) delete state.pendingToolId

  if (event.type === EventType.RUN_FINISHED) {
    state.status = event.outcome?.type === 'cancelled' ? 'cancelled'
      : event.outcome?.type === 'interrupt' ? 'interrupted' : 'completed'
    return
  }
  if (event.type === EventType.RUN_ERROR) {
    state.status = 'failed'
    return
  }
  if (event.type !== EventType.CUSTOM || event.name !== 'keundal.acp.update') return
  const parsed = notification.safeParse(event.value)
  if (!parsed.success) return
  state.sessionId = parsed.data.sessionId
  const payload = parsed.data.update
  if (payload.sessionUpdate === 'plan') state.plan = payload.entries
  else if (payload.sessionUpdate === 'usage_update') {
    const { sessionUpdate: _, ...usage } = payload
    state.usage = usage
  } else if (payload.sessionUpdate === 'tool_call' || payload.sessionUpdate === 'tool_call_update') {
    const { sessionUpdate: _, ...update } = payload
    let tool = state.tools.get(payload.toolCallId)
    if (!tool) {
      tool = { toolCallId: payload.toolCallId }
      state.tools.set(payload.toolCallId, tool)
      state.pendingToolId = payload.toolCallId
    }
    // Null and omission both leave existing values unchanged. Empty collections
    // and strings are concrete replacement values, including removal of a diff.
    Object.assign(tool, Object.fromEntries(Object.entries(update).filter(([, value]) => value != null)))
  }
}
