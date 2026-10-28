import { isAbsolute } from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import type { AgentService } from '@keundal/agent'
import { EventType, type AGUIEvent } from '@keundal/core'
import { isToolApprovalRecord, TOOL_APPROVAL_EVENT, ToolApproval } from '@keundal/tool-approval'

export interface AcpSessionBackend {
  readonly run: AgentService['run']
  dispose(): Promise<void>
}

export interface AcpAgentOptions {
  /** Assemble a separate agent, store and cwd-scoped tools for each session. */
  createSession(options: { cwd: string; toolApproval: ToolApproval }): Promise<AcpSessionBackend>
}

export interface AcpAgent {
  /** One transport connection per app; create a new adapter for each client. */
  readonly app: acp.AgentApp
  dispose(): Promise<void>
}

interface Session {
  readonly backend: AcpSessionBackend
  readonly approval: ToolApproval
  readonly threadId: string
  active?: { controller: AbortController; done: Promise<void> }
}

/** Expose locally assembled Keundal agents through stable ACP v1. Never replays a run. */
export function createAcpAgent(options: AcpAgentOptions): AcpAgent {
  const sessions = new Map<string, Session>()
  const creating = new Set<Promise<unknown>>()
  let connection: acp.AgentConnection | undefined
  let disposed = false
  let disposal: Promise<void> | undefined

  function dispose(): Promise<void> {
    if (disposal) return disposal
    disposed = true
    disposal = Promise.resolve().then(async () => {
      for (const session of sessions.values()) session.active?.controller.abort()
      connection?.close()
      const results = await Promise.allSettled([
        ...creating,
        ...Array.from(sessions.values(), async (session) => {
          await session.active?.done
          await session.backend.dispose()
        })
      ])
      sessions.clear()
      const errors = results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason)
        .filter((error) => !(error instanceof acp.RequestError && error.code === -32800))
      if (errors.length) throw new AggregateError(errors, 'ACP backend disposal failed')
    })
    return disposal
  }

  function sessionById(id: string): Session {
    const session = sessions.get(id)
    if (!session || disposed) throw acp.RequestError.sessionNotFound(id)
    return session
  }

  const app = acp
    .agent({ name: '@keundal/acp' })
    .onConnect((next) => {
      if (disposed || connection) {
        next.close(new Error('Create a separate ACP adapter for each connection'))
        return
      }
      connection = next
      next.signal.addEventListener(
        'abort',
        () => {
          void dispose().catch(() => {})
        },
        { once: true }
      )
    })
    .onRequest(acp.methods.agent.initialize, ({ params }) => {
      if (params.protocolVersion < acp.PROTOCOL_VERSION) {
        throw acp.RequestError.unsupportedProtocolVersion(params.protocolVersion, [acp.PROTOCOL_VERSION])
      }
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
          mcpCapabilities: { http: false, sse: false }
        },
        authMethods: []
      }
    })
    .onRequest(acp.methods.agent.session.new, async ({ params, signal }) => {
      if (disposed) throw acp.RequestError.invalidRequest(undefined, 'ACP adapter is disposed')
      if (!isAbsolute(params.cwd)) throw acp.RequestError.invalidParams(undefined, 'cwd must be absolute')
      if (params.mcpServers.length) throw acp.RequestError.invalidParams(undefined, 'MCP servers are not supported')
      const task = (async () => {
        const approval = new ToolApproval({ default: 'ask' })
        const backend = await options.createSession({ cwd: params.cwd, toolApproval: approval })
        if (disposed || signal.aborted) {
          await backend.dispose()
          throw acp.RequestError.requestCancelled()
        }
        const sessionId = globalThis.crypto.randomUUID()
        sessions.set(sessionId, { backend, approval, threadId: globalThis.crypto.randomUUID() })
        return { sessionId }
      })()
      creating.add(task)
      try {
        return await task
      } finally {
        creating.delete(task)
      }
    })
    .onNotification(acp.methods.agent.session.cancel, ({ params }) => {
      sessionById(params.sessionId).active?.controller.abort()
    })
    .onRequest(acp.methods.agent.session.prompt, async ({ params, client, signal: requestSignal }) => {
      const session = sessionById(params.sessionId)
      if (session.active)
        throw acp.RequestError.invalidRequest(undefined, 'A prompt is already running in this session')
      if (params.prompt.some((block) => block.type !== 'text' && block.type !== 'resource_link')) {
        throw acp.RequestError.invalidParams(undefined, 'Only text and resource links are supported')
      }
      const text = params.prompt
        .map((block) => {
          if (block.type === 'text') return block.text
          if (block.type === 'resource_link') {
            // A link is a reference, not permission to read a local or remote resource.
            return `Resource: ${block.name}\nURI: ${block.uri}${block.description === undefined ? '' : `\nDescription: ${block.description}`}`
          }
          return ''
        })
        .join('\n')
      const controller = new globalThis.AbortController()
      const signal = globalThis.AbortSignal.any([controller.signal, requestSignal])
      const done = Promise.withResolvers<void>()
      session.active = { controller, done: done.promise }
      const runId = globalThis.crypto.randomUUID()
      const tools = new Map<string, { args: string; status: acp.ToolCallStatus }>()
      const update = (value: acp.SessionNotification['update']) =>
        client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: value
        })
      const failTools = async () => {
        for (const [toolCallId, tool] of tools) {
          if (tool.status === 'completed' || tool.status === 'failed') continue
          tool.status = 'failed'
          await update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'failed' })
        }
      }
      let finished = false
      try {
        signal.throwIfAborted()
        for await (const event of session.backend.run(
          {
            threadId: session.threadId,
            runId,
            messages: [{ id: globalThis.crypto.randomUUID(), role: 'user', content: text }],
            tools: [],
            context: [],
            state: {},
            forwardedProps: {}
          },
          { signal }
        )) {
          signal.throwIfAborted()
          if (event.type === EventType.RUN_ERROR) {
            throw acp.RequestError.internalError({ code: event.code }, event.message)
          }
          if (event.type === EventType.RUN_FINISHED) finished = true
          if (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.REASONING_MESSAGE_CONTENT) {
            await update({
              sessionUpdate:
                event.type === EventType.TEXT_MESSAGE_CONTENT ? 'agent_message_chunk' : 'agent_thought_chunk',
              messageId: event.messageId,
              content: { type: 'text', text: event.delta }
            })
          } else if (event.type === EventType.TOOL_CALL_START) {
            tools.set(event.toolCallId, { args: '', status: 'pending' })
            await update({
              sessionUpdate: 'tool_call',
              toolCallId: event.toolCallId,
              title: event.toolCallName,
              name: event.toolCallName,
              status: 'pending'
            })
          } else if (event.type === EventType.TOOL_CALL_ARGS) {
            const tool = tools.get(event.toolCallId)
            if (tool) {
              tool.args += event.delta
              await update({ sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId, rawInput: tool.args })
            }
          } else if (event.type === EventType.TOOL_CALL_END) {
            const tool = tools.get(event.toolCallId)
            if (tool) {
              tool.status = 'in_progress'
              let rawInput: unknown = tool.args
              try {
                rawInput = JSON.parse(tool.args)
              } catch {
                /* Preserve incomplete arguments for diagnostics. */
              }
              await update({
                sessionUpdate: 'tool_call_update',
                toolCallId: event.toolCallId,
                rawInput,
                status: tool.status
              })
            }
          } else if (event.type === EventType.TOOL_CALL_RESULT) {
            const tool = tools.get(event.toolCallId)
            const status = tool?.status === 'failed' ? 'failed' : 'completed'
            if (tool) tool.status = status
            const text = typeof event.content === 'string' ? event.content : JSON.stringify(event.content)
            await update({
              sessionUpdate: 'tool_call_update',
              toolCallId: event.toolCallId,
              status,
              rawOutput: event.content,
              content: [{ type: 'content', content: { type: 'text', text } }]
            })
          } else if (isApproval(event)) {
            const record = event.value
            if (record.threadId !== session.threadId || record.runId !== runId) {
              throw acp.RequestError.internalError(undefined, 'Tool approval does not belong to this run')
            }
            if (record.status === 'requested') {
              const tool = tools.get(record.toolCallId)
              if (tool) tool.status = 'pending'
              await update({ sessionUpdate: 'tool_call_update', toolCallId: record.toolCallId, status: 'pending' })
              let allowed = false
              try {
                const permission = await abortable<acp.RequestPermissionResponse>(
                  client.request(
                    acp.methods.client.session.requestPermission,
                    {
                      sessionId: params.sessionId,
                      toolCall: {
                        toolCallId: record.toolCallId,
                        title: record.toolName,
                        rawInput: record.arguments,
                        status: 'pending'
                      },
                      options: [
                        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
                        { optionId: 'reject_once', kind: 'reject_once', name: 'Reject once' }
                      ]
                    },
                    { cancellationSignal: signal }
                  ),
                  signal
                )
                allowed =
                  !signal.aborted &&
                  permission.outcome.outcome === 'selected' &&
                  permission.outcome.optionId === 'allow_once'
              } finally {
                session.approval.respond(runId, record.requestId, allowed ? 'allow' : 'deny')
              }
              if (tool) tool.status = allowed ? 'in_progress' : 'failed'
              await update({
                sessionUpdate: 'tool_call_update',
                toolCallId: record.toolCallId,
                status: allowed ? 'in_progress' : 'failed'
              })
            }
          }
        }
        signal.throwIfAborted()
        if (!finished) throw acp.RequestError.internalError(undefined, 'Agent stream ended without RUN_FINISHED')
        return { stopReason: 'end_turn' }
      } catch (error) {
        await failTools()
        if (signal.aborted) return { stopReason: 'cancelled' }
        throw error
      } finally {
        controller.abort()
        session.active = undefined
        done.resolve()
      }
    })

  return { app, dispose }
}

function isApproval(event: AGUIEvent): event is Extract<AGUIEvent, { type: 'CUSTOM' }> & {
  value: import('@keundal/tool-approval').ToolApprovalRecord
} {
  return event.type === EventType.CUSTOM && event.name === TOOL_APPROVAL_EVENT && isToolApprovalRecord(event.value)
}

/** ACP cancellation is cooperative; do not wait forever for a permission dialog. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

/** No logging is performed. Reserve output exclusively for ACP JSON-RPC. */
export function createAcpStdioStream(input: Readable = process.stdin, output: Writable = process.stdout): acp.Stream {
  return acp.ndJsonStream(Writable.toWeb(output), Readable.toWeb(input))
}
