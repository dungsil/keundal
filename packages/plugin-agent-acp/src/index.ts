import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import process from 'node:process'
import { Readable, Writable } from 'node:stream'

import * as acp from '@agentclientprotocol/sdk'
import { AgentService, type AgentExecutionOptions } from '@keundal/agent'
import {
  EventType,
  STEER_MESSAGE_EVENT,
  parseRunAgentInput,
  type AGUIEvent,
  type AgentMessage,
  type RunAgentInput
} from '@keundal/core'
import type {} from '@keundal/generation'
import type { LLMEvent } from '@keundal/llm'
import type {} from '@keundal/session'
import { ToolApproval } from '@keundal/tool-approval'
import type { Context } from 'cordis'
import { z } from 'zod'

import { AcpEvents } from './events.js'
export { ACP_UPDATE_EVENT } from './events.js'

const SESSION_EVENT = 'keundal.acp.session'
const sessionSchema = z.object({
  version: z.literal(1),
  command: z.string(),
  args: z.array(z.string()),
  cwd: z.string(),
  sessionId: z.string().min(1),
  sent: z.array(z.object({ id: z.string(), text: z.string() }))
})
type SavedSession = z.infer<typeof sessionSchema>

export interface AcpAgentConfig {
  readonly command: string
  readonly args?: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  /** Local journal metadata; does not select the external agent's model. */
  readonly model?: string
  readonly maxOutputTokens?: number
  readonly connectTimeoutMs?: number
  readonly toolApproval?: ToolApproval
}

interface RemoteSession {
  readonly connection: acp.ClientConnection
  readonly close: () => void
  sessionId?: string
  ready: boolean
  active?: {
    input: RunAgentInput
    signal: AbortSignal
    push: (event: LLMEvent) => void
    events: AcpEvents
  }
  readonly sent: Map<string, string>
}

function userPrompt(message: AgentMessage): { id: string; text: string } {
  if (message.role !== 'user') throw new Error('ACP requires user messages')
  const text =
    typeof message.content === 'string'
      ? message.content
      : message.content
          .map((part) => {
            if (part.type !== 'text') throw new Error('ACP currently supports text prompts only')
            return part.text
          })
          .join('')
  return { id: message.id, text }
}

export class AcpAgent extends AgentService {
  override readonly inputCapabilities = { systemMessages: false }
  private readonly sessions = new Map<string, RemoteSession>()
  private readonly busy = new Set<string>()
  private readonly lifetime = new globalThis.AbortController()
  private readonly approval: ToolApproval

  constructor(
    ctx: Context,
    private readonly config: AcpAgentConfig
  ) {
    super(ctx)
    if (!config.command?.trim()) throw new Error('ACP command is required')
    if (!isAbsolute(config.cwd)) throw new Error('ACP cwd must be an absolute path')
    for (const value of [config.maxOutputTokens ?? 8192, config.connectTimeoutMs ?? 30000]) {
      if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new Error('invalid ACP limit')
    }
    this.approval = config.toolApproval ?? new ToolApproval({ default: 'deny' })
    ctx.fiber.effect(() => () => {
      this.lifetime.abort(new Error('ACP agent disposed'))
      for (const session of this.sessions.values()) session.close()
      this.sessions.clear()
    })
  }

  run(input: RunAgentInput, options: AgentExecutionOptions = {}): AsyncIterableIterator<AGUIEvent> {
    const controller = new globalThis.AbortController()
    const signal = globalThis.AbortSignal.any([
      this.lifetime.signal,
      controller.signal,
      ...(options.signal ? [options.signal] : [])
    ])
    const iterator = this.execute(input, options, signal)
    return {
      next: () => iterator.next(),
      return: async () => {
        controller.abort(new Error('ACP iteration stopped'))
        return iterator.return(undefined)
      },
      throw: async (error?: unknown) => {
        controller.abort(error)
        return iterator.throw(error)
      },
      [Symbol.asyncIterator]() {
        return this
      }
    }
  }

  private async *execute(
    raw: RunAgentInput,
    options: AgentExecutionOptions,
    signal: AbortSignal
  ): AsyncGenerator<AGUIEvent> {
    signal.throwIfAborted()
    if (options.budget) throw new Error('ACP agents do not support local run budgets')
    const input = parseRunAgentInput(raw)
    if (
      input.forwardedProps?.keundalPromptPreset !== undefined ||
      input.forwardedProps?.memoryProjectId !== undefined ||
      input.forwardedProps?.keundalModelRecovery !== undefined
    ) {
      throw new Error('ACP prompt presets, local memory and model recovery are not supported')
    }
    if (this.busy.has(input.threadId)) throw new Error('ACP thread already has an active run')
    this.busy.add(input.threadId)
    let settled = false
    let owned: RemoteSession | undefined
    try {
      const prepared = await this.ctx.session.prepare(input, { signal })
      let remote = this.sessions.get(input.threadId)
      let saved: SavedSession | undefined
      if (!remote || remote.connection.signal.aborted) {
        const runs = (await this.ctx.generation.list({ signal })).filter(
          (run) => run.request.input.threadId === input.threadId
        )
        for (const run of runs) {
          for (const { event } of run.journal) {
            if (event.type === EventType.CUSTOM && event.name === SESSION_EVENT) {
              saved = sessionSchema.parse(event.value)
            }
          }
        }
        if (runs.length && !saved) throw new Error('ACP session cannot be restored; start a new thread')
        if (saved) {
          if (
            saved.command !== this.config.command ||
            saved.cwd !== this.config.cwd ||
            JSON.stringify(saved.args) !== JSON.stringify(this.config.args ?? [])
          ) {
            throw new Error('ACP session configuration changed; start a new thread')
          }
          remote?.close()
          remote = undefined
        }
      }
      if (!remote && !saved && prepared.input.messages.some((message) => message.role !== 'user')) {
        throw new Error('ACP cannot import an existing conversation; start a new thread')
      }
      if (remote?.connection.signal.aborted) throw new Error('ACP session is closed; start a new thread')
      const users = prepared.input.messages.filter((message) => message.role === 'user').map(userPrompt)
      const sentMessages = remote?.sent ?? new Map(saved?.sent.map(({ id, text }) => [id, text]))
      for (const message of users) {
        const sent = sentMessages.get(message.id)
        if (sent !== undefined && sent !== message.text) throw new Error('ACP cannot edit a previously sent message')
      }
      if (
        prepared.input.messages.some((message) => message.role === 'system' || message.role === 'developer') ||
        prepared.input.context.length ||
        prepared.input.tools.length
      ) {
        throw new Error('ACP system messages, context and caller tools are not supported')
      }
      const pending = users.filter((message) => !sentMessages.has(message.id))
      if (!pending.length) throw new Error('ACP requires a new user message')
      if (!remote) {
        remote = this.connect(saved)
        this.sessions.set(input.threadId, remote)
      }
      const session = remote
      owned = session
      const prompt = this.prompt.bind(this)
      for await (const event of this.ctx.generation.run(
        {
          input: prepared.input,
          sessionRevision: prepared.revision,
          model: this.config.model ?? this.config.command,
          maxOutputTokens: this.config.maxOutputTokens ?? 8192
        },
        {
          signal,
          durableCustomEvents: [SESSION_EVENT],
          stream: async function* (_request, execution) {
            let prompts = pending
            while (prompts.length) {
              yield* prompt(session, prepared.input, prompts, execution?.signal ?? signal)
              prompts = []
              for (const message of options.steer?.take() ?? []) {
                const next = userPrompt(message)
                if (session.sent.has(message.id)) throw new Error('ACP steer message was already sent')
                yield { type: EventType.CUSTOM, name: STEER_MESSAGE_EVENT, value: message }
                prompts.push(next)
              }
            }
          }
        }
      )) {
        if (event.type === EventType.RUN_FINISHED) settled = true
        yield event
      }
    } finally {
      if (!settled) owned?.close()
      this.busy.delete(input.threadId)
    }
  }

  private connect(saved?: SavedSession): RemoteSession {
    const child = spawn(this.config.command, [...(this.config.args ?? [])], {
      cwd: this.config.cwd,
      env: this.config.env ? { ...process.env, ...this.config.env } : process.env,
      stdio: ['pipe', 'pipe', 'inherit'],
      shell: false
    })
    let remote: RemoteSession
    const connection = acp
      .client({ name: 'keundal' })
      .onNotification('session/update', ({ params }) => {
        if (params.sessionId !== remote.sessionId || !remote.active) return
        for (const event of remote.active.events.update(params)) remote.active.push(event)
      })
      .onRequest('session/request_permission', async ({ params }) => {
        const active = remote.active
        if (!active || params.sessionId !== remote.sessionId) return { outcome: { outcome: 'cancelled' } }
        const allow = params.options.find((option) => option.kind === 'allow_once')
        const reject = params.options.find((option) => option.kind === 'reject_once')
        if (!allow) return { outcome: { outcome: 'cancelled' } }
        for (const event of active.events.update({
          sessionId: params.sessionId,
          update: {
            ...params.toolCall,
            sessionUpdate: 'tool_call_update'
          }
        }))
          active.push(event)
        const allowed = await this.approval.authorize(
          {
            threadId: active.input.threadId,
            runId: active.input.runId,
            toolCallId: active.events.toolCallId(params.toolCall.toolCallId),
            toolName: params.toolCall.name ?? params.toolCall.title ?? params.toolCall.toolCallId,
            arguments: { input: params.toolCall.rawInput },
            operation: {
              kind: params.toolCall.kind ?? 'other',
              paths: params.toolCall.locations?.map((location) => location.path)
            }
          },
          globalThis.AbortSignal.any([active.signal, connection.signal]),
          async (event) => {
            active.push(event)
          }
        )
        const selected = allowed ? allow : reject
        return { outcome: selected ? { outcome: 'selected', optionId: selected.optionId } : { outcome: 'cancelled' } }
      })
      .connect(
        acp.ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>)
      )
    let closed = false
    remote = {
      connection,
      sessionId: saved?.sessionId,
      ready: false,
      sent: new Map(saved?.sent.map(({ id, text }) => [id, text])),
      close: () => {
        if (closed) return
        closed = true
        connection.close()
        if (child.exitCode !== null || child.signalCode !== null) return
        child.kill()
        // Do not leave an uncooperative agent behind after cancellation/disposal.
        const force = globalThis.setTimeout(() => child.kill('SIGKILL'), 1000)
        force.unref()
        child.once('exit', () => globalThis.clearTimeout(force))
      }
    }
    child.once('error', (error) => connection.close(error))
    child.once('exit', () => connection.close(new Error('ACP agent exited')))
    return remote
  }

  private async *prompt(
    remote: RemoteSession,
    input: RunAgentInput,
    pending: { id: string; text: string }[],
    signal: AbortSignal
  ): AsyncGenerator<LLMEvent> {
    const events: LLMEvent[] = []
    let wake = Promise.withResolvers<void>()
    const push = (event: LLMEvent) => {
      events.push(event)
      wake.resolve()
    }
    const translator = new AcpEvents()
    let completed = false
    const cancel = () => {
      if (remote.sessionId)
        void remote.connection.agent.notify('session/cancel', { sessionId: remote.sessionId }).catch(() => {})
      remote.close()
      wake.resolve()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      if (!remote.ready) {
        const connectSignal = globalThis.AbortSignal.any([
          signal,
          globalThis.AbortSignal.timeout(this.config.connectTimeoutMs ?? 30000)
        ])
        const timedOut = () => remote.close()
        connectSignal.addEventListener('abort', timedOut, { once: true })
        try {
          const init = await remote.connection.agent.request(
            'initialize',
            {
              protocolVersion: acp.PROTOCOL_VERSION,
              clientCapabilities: {},
              clientInfo: { name: 'keundal', version: '0.0.0' }
            },
            { cancellationSignal: connectSignal }
          )
          if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error('unsupported ACP protocol version')
          if (remote.sessionId) {
            if (!init.agentCapabilities?.loadSession) {
              throw new Error('ACP session cannot be restored: agent does not support session/load; start a new thread')
            }
            // session/load replays history. With no active run, updates are ignored and
            // permission requests are cancelled instead of repeating completed work.
            await remote.connection.agent.request(
              'session/load',
              { sessionId: remote.sessionId, cwd: this.config.cwd, mcpServers: [] },
              { cancellationSignal: connectSignal }
            )
          } else {
            const session = await remote.connection.agent.request(
              'session/new',
              { cwd: this.config.cwd, mcpServers: [] },
              { cancellationSignal: connectSignal }
            )
            remote.sessionId = session.sessionId
          }
          remote.ready = true
        } finally {
          connectSignal.removeEventListener('abort', timedOut)
        }
      }
      // Record dispatch before sending: an interrupted prompt must never be replayed
      // automatically, even if its response was not committed locally.
      for (const message of pending) remote.sent.set(message.id, message.text)
      yield {
        type: EventType.CUSTOM,
        name: SESSION_EVENT,
        value: {
          version: 1,
          command: this.config.command,
          args: [...(this.config.args ?? [])],
          cwd: this.config.cwd,
          sessionId: remote.sessionId!,
          sent: [...remote.sent].map(([id, text]) => ({ id, text }))
        } satisfies SavedSession
      }
      signal.throwIfAborted()
      remote.active = { input, signal, push, events: translator }
      let done = false
      let failure: unknown
      const prompt: acp.PromptRequest = {
        sessionId: remote.sessionId!,
        prompt: pending.map(({ text }) => ({ type: 'text', text }))
      }
      const request = remote.connection.agent
        .request('session/prompt', prompt, { cancellationSignal: signal })
        .then((response) => {
          if (response.stopReason !== 'end_turn') throw new Error(`ACP prompt stopped: ${response.stopReason}`)
        })
        .catch((error: unknown) => {
          failure = error
        })
        .finally(() => {
          done = true
          wake.resolve()
        })
      while (!done || events.length) {
        signal.throwIfAborted()
        if (events.length) yield events.shift()!
        else {
          await wake.promise
          wake = Promise.withResolvers<void>()
        }
      }
      await request
      if (failure) throw failure
      signal.throwIfAborted()
      yield* translator.end()
      completed = true
    } finally {
      remote.active = undefined
      signal.removeEventListener('abort', cancel)
      if (!completed) remote.close()
    }
  }
}

export const acpAgentPlugin = Object.assign(
  (ctx: Context, config: AcpAgentConfig) => {
    new AcpAgent(ctx, config)
  },
  { inject: ['session', 'generation'] }
)
export default acpAgentPlugin
