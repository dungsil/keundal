import { parseRunBudget, type RunBudget } from '@keundal/agent'
import { ChatMessageAssembly } from '@keundal/chat/chat-message'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { ChatMessagePublisher } from '@keundal/chat/chat-message-publisher'
import { branchChat, chatSummary, validateChatTitle } from '@keundal/chat/chat-store'
import type { ChatStoreLike, ChatSummary, LocalChat } from '@keundal/chat/chat-store'
import { toMessages } from '@keundal/chat/messages'
import { resolveModel, type ModelOption } from '@keundal/chat/models'
import { ChatRuns, createActiveChatRun, settleChatRun, type ActiveChatRun } from '@keundal/chat/run-queue'
import { EventType, parseAGUIEvent, type AGUIEvent, type ExecutionOptions } from '@keundal/core'
import { type GenerationSnapshot } from '@keundal/generation'
import { type Reasoning, STREAM_LIMITS } from '@keundal/llm'
import { parsePromptPreset, type PromptPreset } from '@keundal/prompt'
import { type SessionSnapshot } from '@keundal/session'
import { type SubagentRole } from '@keundal/subagent'
import type { TaskService, TaskSnapshot } from '@keundal/task'

import { boundRemoteResponse, RemoteResponseLimitError, RemoteStreamBudget } from './response-budget'

type ChatState = { web: LocalChat }

export interface RemoteAgentInfo {
  readonly endpoint: string
  readonly token: string
}

interface RemoteModel {
  readonly id: string
  readonly provider: 'openai' | 'gemini' | 'anthropic'
  readonly contextWindow: number
  readonly maxOutputTokens: number
}

const randomUUID = () => globalThis.crypto.randomUUID()

/** 스트림이 끊긴 뒤 같은 실행을 다시 구독하는 최대 연속 시도 수입니다. */
const MAX_RECONNECT_ATTEMPTS = 3

/** SSE 프레임입니다. journal 이벤트는 sequence를 id로 가지며, 종료 오류는 id가 없습니다. */
interface StreamFrame {
  readonly id?: number
  readonly event: AGUIEvent
}

const instructions = (webSearch: boolean, systemPrompt?: string) => {
  const builtIn = `You are a knowledgeable and helpful AI assistant. Be clear, accurate and concise.
Do not use markdown headings. Use bold text for section labels instead.
${webSearch ? 'Use native web search when current information is needed and cite sources.' : 'Web search is disabled. Do not claim to have verified live information.'}`
  const custom = systemPrompt?.trim()
  return custom ? `${builtIn}\n\n${custom}` : builtIn
}

/** Keundal HTTP 호스트에 대화·실행을 맡기는 클라이언트 저장소입니다. */
export class RemoteChatStore implements ChatStoreLike {
  /** 실행은 호스트가 소유하므로 연결이 끊겨도 계속되고, journal 커서로 다시 구독합니다. */
  readonly execution = 'host'
  private readonly runs = new ChatRuns({
    read: (id) => this.get(id),
    write: async (id, change) => {
      const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
      const chat = this.chat(snapshot)
      if (!chat) throw new Error('Chat not found')
      const next = change(chat)
      await this.save(snapshot, next)
      return next
    }
  })
  private readonly active = this.runs.active
  private modelsCache: RemoteModel[] | undefined

  readonly tasks: Pick<TaskService, 'get' | 'list' | 'cancel'> = {
    list: async (options) => {
      const query = options?.parentThreadId ? `?parentThreadId=${encodeURIComponent(options.parentThreadId)}` : ''
      return (await this.call(`/tasks${query}`)).json() as Promise<TaskSnapshot[]>
    },
    get: async (id) => {
      const response = await this.raw(`/tasks/${encodeURIComponent(id)}`)
      if (response.status === 404) {
        await response.body?.cancel()
        return undefined
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Keundal task request failed (HTTP ${response.status})`)
      }
      return response.json() as Promise<TaskSnapshot>
    },
    cancel: async (id) => {
      const result = (await (
        await this.call(`/tasks/${encodeURIComponent(id)}/cancel`, { method: 'POST' })
      ).json()) as { cancelled: boolean }
      return result.cancelled
    }
  }

  constructor(
    private connection: RemoteAgentInfo,
    private readonly request: typeof globalThis.fetch = (input, init) => globalThis.fetch(input, init)
  ) {}

  protected reconnect(connection: RemoteAgentInfo) {
    this.connection = connection
    this.modelsCache = undefined
  }

  private url(path: string) {
    return `${this.connection.endpoint.replace(/\/+$/, '')}${path}`
  }

  private async raw(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    if (this.connection.token) headers.set('authorization', `Bearer ${this.connection.token}`)
    if (init.body !== undefined) headers.set('content-type', 'application/json')
    return boundRemoteResponse(
      await this.request(this.url(path), { ...init, headers, cache: 'no-store' }),
      init.signal ?? undefined
    )
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.raw(path, init)
    if (!response.ok) {
      const detail = await response.text().catch((error) => {
        if (error instanceof RemoteResponseLimitError) throw error
        return ''
      })
      throw new Error(detail || `Keundal host request failed (HTTP ${response.status})`)
    }
    return response
  }

  async catalog(options: import('@keundal/core').ExecutionOptions = {}): Promise<{
    skills: readonly import('@keundal/skill').SkillSummary[]
    tools: readonly import('@keundal/skill').SkillSummary[]
  }> {
    return (await this.call('/catalog', { signal: options.signal })).json()
  }

  private snapshot(value: unknown): SessionSnapshot {
    return value as SessionSnapshot
  }

  private chat(snapshot: SessionSnapshot | undefined): LocalChat | undefined {
    return (snapshot?.state as ChatState | undefined)?.web
  }

  async list(): Promise<LocalChat[]> {
    const response = await this.call('/threads')
    const snapshots = (await response.json()) as SessionSnapshot[]
    return snapshots
      .flatMap((snapshot) => {
        const chat = this.chat(snapshot)
        return chat ? [chat] : []
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async listSummaries(): Promise<ChatSummary[]> {
    const response = await this.call('/threads?view=summary&stateFields=web.id,web.title,web.createdAt')
    const snapshots = (await response.json()) as { state?: { web?: ChatSummary } }[]
    return snapshots
      .flatMap((snapshot) => {
        const chat = snapshot.state?.web
        return chat &&
          typeof chat.id === 'string' &&
          typeof chat.createdAt === 'string' &&
          (chat.title === null || typeof chat.title === 'string')
          ? [chatSummary(chat)]
          : []
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async get(id: string): Promise<LocalChat | undefined> {
    const response = await this.raw(`/threads/${encodeURIComponent(id)}`)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 404) return undefined
      throw new Error(`Keundal host request failed (HTTP ${response.status})`)
    }
    return this.chat(this.snapshot(await response.json()))
  }

  async getRun(runId: string, options: ExecutionOptions = {}): Promise<GenerationSnapshot | undefined> {
    const response = await this.raw(`/runs/${encodeURIComponent(runId)}`, { signal: options.signal })
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      if (response.status === 404) return undefined
      throw new Error(`Keundal host request failed (HTTP ${response.status})`)
    }
    return (await response.json()) as GenerationSnapshot
  }

  private async save(snapshot: SessionSnapshot | undefined, chat: LocalChat) {
    const response = await this.call(`/threads/${encodeURIComponent(chat.id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        expectedRevision: snapshot?.revision ?? 0,
        mode: 'replace',
        messages: toMessages(chat.messages, chat.model),
        state: { web: chat }
      })
    })
    return this.snapshot(await response.json())
  }

  private async complete(
    id: string,
    runId: string,
    message: ChatMessage,
    steered: ChatMessageAssembly['steered'],
    active?: ActiveChatRun
  ) {
    const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
    const chat = this.chat(snapshot)
    if (!chat || chat.pendingRunId !== runId) throw new Error('Chat changed while the response was running')
    await this.save(snapshot, settleChatRun(chat, { runId, message, steered }, active))
  }

  enqueue(id: string, message: ChatMessage) {
    return this.runs.enqueue(id, message)
  }

  dequeue(id: string, messageId: string) {
    return this.runs.dequeue(id, messageId)
  }

  async respondToToolApproval(runId: string, requestId: string, decision: 'allow' | 'deny') {
    const response = await this.raw(`/runs/${encodeURIComponent(runId)}/approvals/${encodeURIComponent(requestId)}`, {
      method: 'POST',
      body: JSON.stringify({ decision })
    })
    if (response.status !== 202 && response.status !== 409)
      throw new Error(`Approval request failed (HTTP ${response.status})`)
    await response.body?.cancel()
    return response.status === 202
  }

  steer(id: string, message: ChatMessage) {
    return this.runs.steer(id, message, async (run) => {
      const chat = await this.get(id)
      const response = await this.raw(`/runs/${encodeURIComponent(run.runId!)}/steer`, {
        method: 'POST',
        body: JSON.stringify({ messages: toMessages([message], chat?.model ?? '') })
      })
      void response.body?.cancel().catch(() => {})
      return response.status === 202
    })
  }

  async create(id: string, message: ChatMessage, model: string): Promise<LocalChat> {
    const existing = await this.raw(`/threads/${encodeURIComponent(id)}`)
    void existing.body?.cancel().catch(() => {})
    if (existing.status !== 404) {
      if (existing.ok) throw new Error('Chat already exists')
      throw new Error(`Keundal host request failed (HTTP ${existing.status})`)
    }
    const chat: LocalChat = {
      id,
      title: null,
      createdAt: new Date().toISOString(),
      messages: [message],
      votes: [],
      model,
      started: false,
      isOwner: true,
      visibility: 'private'
    }
    await this.save(undefined, chat)
    return chat
  }

  private async update(id: string, change: (chat: LocalChat) => LocalChat) {
    if (this.active.has(id)) throw new Error('Stop the current response before changing this chat')
    const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
    const chat = this.chat(snapshot)
    if (!chat) throw new Error('Chat not found')
    await this.save(snapshot, change(chat))
  }

  async rename(id: string, title: string) {
    title = validateChatTitle(title)
    await this.update(id, (chat) => ({ ...chat, title }))
  }

  /** 기존 `GET`·`PUT /threads/:id`만 사용합니다. 원래 대화는 읽기만 하고 새 대화는 한 번의 `PUT`으로 저장합니다. */
  async branch(sourceId: string, messageId: string, newId: string): Promise<LocalChat> {
    const source = await this.get(sourceId)
    if (!source) throw new Error('Chat not found')
    const existing = await this.raw(`/threads/${encodeURIComponent(newId)}`)
    void existing.body?.cancel().catch(() => {})
    if (existing.status !== 404) {
      if (existing.ok) throw new Error('Chat already exists')
      throw new Error(`Keundal host request failed (HTTP ${existing.status})`)
    }
    const chat = branchChat(source, messageId, newId, new Date().toISOString())
    await this.save(undefined, chat)
    return chat
  }

  async truncate(id: string, messageId: string, type: 'edit' | 'regenerate') {
    await this.update(id, (chat) => {
      const index = chat.messages.findIndex((message) => message.id === messageId)
      if (index < 0 || chat.messages[index]!.role !== (type === 'edit' ? 'user' : 'assistant'))
        throw new Error('Invalid message')
      const messages = chat.messages.slice(0, index + (type === 'edit' ? 1 : 0))
      return {
        ...chat,
        messages,
        pendingRunId: undefined,
        votes: chat.votes.filter((vote) => messages.some((message) => message.id === vote.messageId))
      }
    })
  }

  async vote(id: string, messageId: string, isUpvoted?: boolean) {
    await this.update(id, (chat) => {
      if (!chat.messages.some((message) => message.id === messageId && message.role === 'assistant'))
        throw new Error('Assistant message not found')
      const votes = chat.votes.filter((vote) => vote.messageId !== messageId)
      if (isUpvoted !== undefined) votes.push({ chatId: id, messageId, isUpvoted })
      return { ...chat, votes }
    })
  }

  async delete(id: string) {
    const active = this.active.get(id)
    if (active) {
      active.abort.abort()
      await active.done
    }
    const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
    const response = await this.call(`/threads/${encodeURIComponent(id)}?revision=${snapshot.revision}`, {
      method: 'DELETE'
    })
    void response.body?.cancel().catch(() => {})
  }

  async models(): Promise<ModelOption[]> {
    if (!this.modelsCache) {
      const response = await this.call('/models')
      const result = (await response.json()) as { models: RemoteModel[] }
      this.modelsCache = result.models
    }
    return this.modelsCache.map((model) => {
      const provider = model.provider === 'gemini' ? 'google' : model.provider
      return {
        value: `${provider}/${model.id}`,
        label: model.id,
        icon: `i-simple-icons-${provider}`,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens
      }
    })
  }

  private async model(raw: string): Promise<RemoteModel> {
    if (!this.modelsCache) await this.models()
    const value = resolveModel(raw)
    const found = this.modelsCache?.find(
      (model) =>
        (model.provider === 'gemini' ? 'google' : model.provider) === value.provider &&
        (model.id === value.id || model.id === raw)
    )
    if (!found) throw new Error(`Keundal host does not provide this model: ${raw}`)
    return found
  }

  protected async generateTitle(value: string, message: ChatMessage, signal?: AbortSignal): Promise<string> {
    const model = await this.model(value)
    const provider = model.provider === 'gemini' ? 'google' : model.provider
    const first = toMessages([message], `${provider}/${model.id}`)[0]
    if (!first) return ''
    const response = await this.call('/title', {
      method: 'POST',
      signal,
      body: JSON.stringify({ model: model.id, message: first })
    })
    const result = (await response.json()) as { title: string }
    return result.title
  }

  async *respond(
    id: string,
    request: {
      messages: ChatMessage[]
      model: string
      titleModel?: string
      systemPrompt?: string
      promptPreset?: PromptPreset
      subagentRoles?: readonly SubagentRole[]
      budget?: RunBudget
      reasoning?: Reasoning
      webSearch?: boolean
      onMessage?: (message: ChatMessage) => void
      onTitle?: (title: string) => void
    },
    signal?: AbortSignal
  ): AsyncGenerator<AGUIEvent> {
    if (this.active.has(id)) throw new Error('A response is already running')
    const promptPreset = request.promptPreset === undefined ? undefined : parsePromptPreset(request.promptPreset)
    const runBudget = request.budget === undefined ? undefined : parseRunBudget(request.budget)
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    const run = createActiveChatRun(abort, done)
    this.active.set(id, run)
    let settled = false
    try {
      combined.throwIfAborted()
      const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
      const current = this.chat(snapshot)
      if (!current) throw new Error('Chat not found')
      const resuming = !!current.pendingRunId
      const runId = current.pendingRunId ?? randomUUID()
      // 대기열에서 꺼낸 메시지는 대화에 넣는 같은 커밋에서 대기열에서 지워 중복 실행을 막습니다.
      const sent = new Set(request.messages.map((message) => message.id))
      const queue = (current.queue ?? []).filter((message) => !sent.has(message.id))
      let chat: LocalChat = resuming
        ? current
        : {
            ...current,
            messages: request.messages,
            model: request.model,
            started: true,
            pendingRunId: runId,
            queue: queue.length ? queue : undefined
          }
      const saved = resuming ? snapshot : await this.save(snapshot, chat)
      if (!resuming && !chat.title && chat.messages[0]) {
        try {
          chat = {
            ...chat,
            title: validateChatTitle(
              await this.generateTitle(request.titleModel || request.model, chat.messages[0], combined)
            )
          }
          await this.save(saved, chat)
          request.onTitle?.(chat.title!)
        } catch {
          // A title failure must not discard the saved conversation.
        }
      }
      combined.throwIfAborted()
      const selected = await this.model(chat.model)
      const projection = new ChatMessageAssembly(runId)
      const publisher = new ChatMessagePublisher(request.onMessage)
      let finished: Extract<AGUIEvent, { type: 'RUN_FINISHED' }> | undefined
      let failed = false
      // 연결 종료는 호스트 실행을 멈추지 않으므로, 사용자의 중단은 명시적인 취소 요청으로 보냅니다.
      let cancelled: Promise<unknown> | undefined
      let limited = false
      const cancel = () => {
        cancelled = this.raw(`/runs/${encodeURIComponent(runId)}/cancel`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000)
        })
          .then((response) => {
            void response.body?.cancel().catch(() => {})
          })
          .catch(() => {})
      }
      combined.addEventListener('abort', cancel, { once: true })
      run.runId = runId
      // 마지막으로 적용한 journal sequence입니다. 재연결은 이 커서 다음부터 받고, 이미 적용한 id는 건너뜁니다.
      let cursor = -1
      const budget = new RemoteStreamBudget()
      try {
        let response = resuming
          ? await this.call(`/runs/${encodeURIComponent(runId)}/events`, { signal: combined })
          : await this.call('/runs', {
              method: 'POST',
              headers: {
                'x-keundal-model': selected.id,
                ...(request.reasoning === undefined ? {} : { 'x-keundal-reasoning': String(request.reasoning) })
              },
              signal: combined,
              body: JSON.stringify({
                threadId: id,
                runId,
                ...(runBudget === undefined ? {} : { budget: runBudget }),
                state: {
                  web: chat,
                  ...(request.subagentRoles === undefined ? {} : { subagentRoles: request.subagentRoles })
                },
                context: [],
                tools: [],
                forwardedProps: { keundalPromptPreset: promptPreset },
                messages: [
                  {
                    id: 'keundal:web-instructions',
                    role: 'system',
                    content: instructions(!!request.webSearch, request.systemPrompt)
                  },
                  ...toMessages(request.messages, request.model)
                ]
              })
            })
        let attempts = 0
        for (;;) {
          try {
            for await (const frame of this.frames(response, combined, budget)) {
              if (frame.id !== undefined) {
                if (frame.id <= cursor) continue
                cursor = frame.id
              }
              attempts = 0
              const event = frame.event
              projection.apply(event)
              publisher.update(event, projection.message)
              if (event.type === EventType.RUN_FINISHED) finished = event
              else {
                if (event.type === EventType.RUN_ERROR) failed = true
                yield event
              }
            }
          } catch (error) {
            // 사용자의 중단과 달리 네트워크 오류는 같은 실행을 다시 구독해 이어받습니다.
            if (combined.aborted || error instanceof RemoteResponseLimitError) throw error
          }
          if (finished || failed) break
          combined.throwIfAborted()
          if (++attempts > MAX_RECONNECT_ATTEMPTS) throw new Error('Keundal generation did not finish')
          const backoff = Promise.withResolvers<void>()
          globalThis.setTimeout(backoff.resolve, 100 * 2 ** attempts)
          await backoff.promise
          combined.throwIfAborted()
          response = await this.call(`/runs/${encodeURIComponent(runId)}/events?afterSequence=${cursor}`, {
            signal: combined
          })
        }
      } catch (error) {
        if (error instanceof RemoteResponseLimitError) {
          limited = true
          cancel()
        }
        if (!combined.aborted && !failed) {
          yield { type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : String(error) }
        }
      } finally {
        combined.removeEventListener('abort', cancel)
        if (cancelled && !limited) {
          await cancelled
          // 취소 전에 호스트가 기록한 부분 응답까지 저장하도록 종료된 journal의 나머지를 읽습니다.
          // 호스트가 실행을 끝냈으므로 구독은 마지막 기록에서 끝납니다.
          try {
            const rest = await this.call(`/runs/${encodeURIComponent(runId)}/events?afterSequence=${cursor}`)
            for await (const frame of this.frames(rest, new AbortController().signal, budget)) {
              if (frame.id === undefined || frame.id <= cursor) continue
              cursor = frame.id
              projection.apply(frame.event)
              publisher.update(frame.event, projection.message)
            }
          } catch {
            // 호스트에 연결할 수 없으면 받은 지점까지만 저장합니다. 호스트의 journal에는 전체 기록이 남습니다.
          }
        }
        run.closing = true
        projection.finish(chat.model)
        await this.complete(id, runId, projection.message, projection.steered, run)
        settled = true
        publisher.finish(projection.message)
      }
      if (finished) yield finished
    } finally {
      try {
        await this.runs.release(id, run, settled)
      } finally {
        release()
      }
    }
  }

  /** SSE 응답을 프레임으로 읽습니다. id 줄은 journal sequence이며 재연결 커서로 사용합니다. */
  private async *frames(
    response: Response,
    signal: AbortSignal,
    budget: RemoteStreamBudget
  ): AsyncGenerator<StreamFrame> {
    if (!response.body) throw new Error('Keundal host returned an empty stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // Include SSE id/data framing overhead around a maximum-size host event.
    const limit = STREAM_LIMITS.eventBytes + 1024
    let buffer = new Uint8Array(4096)
    let length = 0
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        signal.throwIfAborted()
        if (done) break
        budget.read(value.byteLength)
        for (const byte of value) {
          if (length === limit) throw new RemoteResponseLimitError('Remote response frame byte limit exceeded')
          if (length === buffer.length) {
            const next = new Uint8Array(Math.min(buffer.length * 2, limit))
            next.set(buffer)
            buffer = next
          }
          buffer[length++] = byte
          if (
            byte !== 10 ||
            !(
              buffer[length - 2] === 10 ||
              (length >= 4 && buffer[length - 2] === 13 && buffer[length - 3] === 10 && buffer[length - 4] === 13)
            )
          )
            continue
          budget.frame()
          const chunk = decoder.decode(buffer.subarray(0, length))
          length = 0
          let id: number | undefined
          let data: string | undefined
          for (const line of chunk.split(/\r?\n/)) {
            if (line.startsWith('id: ')) id = Number(line.slice(4))
            else if (line.startsWith('data: ')) data = line.slice(6)
          }
          if (data !== undefined) {
            const value: unknown = JSON.parse(data)
            budget.event(value)
            const event = parseAGUIEvent(value)
            yield Number.isSafeInteger(id) ? { id, event } : { event }
          }
        }
      }
    } finally {
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /** 저장된 journal만 다시 그립니다. 호스트의 LLM을 재호출하지 않습니다. */
  async recover() {
    const response = await this.call('/recover', { method: 'POST' })
    const runs = (await response.json()) as GenerationSnapshot[]
    for (const run of runs) {
      if (run.status === 'running') continue
      const id = run.request.input.threadId
      const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
      const chat = this.chat(snapshot)
      if (!chat || chat.pendingRunId !== run.request.input.runId) continue
      const projection = new ChatMessageAssembly(run.request.input.runId)
      for (const entry of run.journal) projection.apply(entry.event)
      projection.finish(chat.model)
      await this.complete(id, run.request.input.runId, projection.message, projection.steered)
    }
  }

  async stop() {
    for (const active of this.active.values()) active.abort.abort()
    await Promise.all([...this.active.values()].map((active) => active.done))
  }
}
