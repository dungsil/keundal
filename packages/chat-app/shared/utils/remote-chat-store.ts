import { ChatMessagePublisher } from './chat-message-publisher'
import { EventType, type AGUIEvent, type GenerationSnapshot, type SessionSnapshot } from '@keundal/core'
import { ChatMessageAssembly } from './chat-message'
import type { ChatMessage } from './chat-message'
import type { ChatStoreLike, LocalChat } from './chat-store'
import { toMessages } from './keundal'
import { resolveModel, type ModelOption } from './models'

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

const instructions = (webSearch: boolean) => `You are a knowledgeable and helpful AI assistant. Be clear, accurate and concise.
Do not use markdown headings. Use bold text for section labels instead.
${webSearch ? 'Use native web search when current information is needed and cite sources.' : 'Web search is disabled. Do not claim to have verified live information.'}`

/** Keundal HTTP 호스트에 대화·실행을 맡기는 클라이언트 저장소입니다. */
export class RemoteChatStore implements ChatStoreLike {
  private readonly active = new Map<string, { abort: AbortController, done: Promise<void> }>()
  private modelsCache: RemoteModel[] | undefined

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
    return this.request(this.url(path), { ...init, headers })
  }

  private async call(path: string, init: RequestInit = {}): Promise<Response> {
    const response = await this.raw(path, init)
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(detail || `Keundal host request failed (HTTP ${response.status})`)
    }
    return response
  }

  private snapshot(value: unknown): SessionSnapshot {
    return value as SessionSnapshot
  }

  private chat(snapshot: SessionSnapshot | undefined): LocalChat | undefined {
    return (snapshot?.state as ChatState | undefined)?.web
  }

  async list(): Promise<LocalChat[]> {
    const response = await this.call('/threads')
    const snapshots = await response.json() as SessionSnapshot[]
    return snapshots.flatMap((snapshot) => {
      const chat = this.chat(snapshot)
      return chat ? [chat] : []
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async get(id: string): Promise<LocalChat | undefined> {
    const response = await this.raw(`/threads/${encodeURIComponent(id)}`)
    if (response.status === 404) return undefined
    if (!response.ok) throw new Error(`Keundal host request failed (HTTP ${response.status})`)
    return this.chat(this.snapshot(await response.json()))
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

  private async complete(id: string, runId: string, message: ChatMessage) {
    const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
    const chat = this.chat(snapshot)
    if (!chat || chat.pendingRunId !== runId) throw new Error('Chat changed while the response was running')
    await this.save(snapshot, { ...chat, messages: [...chat.messages, message], pendingRunId: undefined })
  }

  async create(id: string, message: ChatMessage, model: string): Promise<LocalChat> {
    const existing = await this.raw(`/threads/${encodeURIComponent(id)}`)
    if (existing.status !== 404) {
      if (existing.ok) throw new Error('Chat already exists')
      throw new Error(`Keundal host request failed (HTTP ${existing.status})`)
    }
    const chat: LocalChat = {
      id, title: null, createdAt: new Date().toISOString(), messages: [message], votes: [], model,
      started: false, isOwner: true, visibility: 'private'
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
    title = title.trim()
    if (!title || title.length > 100) throw new Error('Title must contain 1–100 characters')
    await this.update(id, chat => ({ ...chat, title }))
  }

  async truncate(id: string, messageId: string, type: 'edit' | 'regenerate') {
    await this.update(id, (chat) => {
      const index = chat.messages.findIndex(message => message.id === messageId)
      if (index < 0 || chat.messages[index]!.role !== (type === 'edit' ? 'user' : 'assistant')) throw new Error('Invalid message')
      const messages = chat.messages.slice(0, index + (type === 'edit' ? 1 : 0))
      return { ...chat, messages, pendingRunId: undefined, votes: chat.votes.filter(vote => messages.some(message => message.id === vote.messageId)) }
    })
  }

  async vote(id: string, messageId: string, isUpvoted?: boolean) {
    await this.update(id, (chat) => {
      if (!chat.messages.some(message => message.id === messageId && message.role === 'assistant')) throw new Error('Assistant message not found')
      const votes = chat.votes.filter(vote => vote.messageId !== messageId)
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
    await this.call(`/threads/${encodeURIComponent(id)}?revision=${snapshot.revision}`, { method: 'DELETE' })
  }

  async models(): Promise<ModelOption[]> {
    if (!this.modelsCache) {
      const response = await this.call('/models')
      const result = await response.json() as { models: RemoteModel[] }
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
    const found = this.modelsCache?.find(model =>
      (model.provider === 'gemini' ? 'google' : model.provider) === value.provider
      && (model.id === value.id || model.id === raw))
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
    const result = await response.json() as { title: string }
    return result.title
  }

  async* respond(id: string, request: {
    messages: ChatMessage[]
    model: string
    titleModel?: string
    reasoning?: boolean
    webSearch?: boolean
    onMessage?: (message: ChatMessage) => void
    onTitle?: (title: string) => void
  }, signal?: AbortSignal): AsyncGenerator<AGUIEvent> {
    if (this.active.has(id)) throw new Error('A response is already running')
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    let release!: () => void
    const done = new Promise<void>(resolve => release = resolve)
    this.active.set(id, { abort, done })
    try {
      combined.throwIfAborted()
      const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
      const current = this.chat(snapshot)
      if (!current) throw new Error('Chat not found')
      const runId = randomUUID()
      let chat = { ...current, messages: request.messages, model: request.model, started: true, pendingRunId: runId }
      const saved = await this.save(snapshot, chat)
      if (!chat.title && chat.messages[0]) {
        try {
          chat = { ...chat, title: await this.generateTitle(request.titleModel || request.model, chat.messages[0], combined) }
          await this.save(saved, chat)
          request.onTitle?.(chat.title!)
        } catch {
          // A title failure must not discard the saved conversation.
        }
      }
      combined.throwIfAborted()
      const selected = await this.model(request.model)
      const projection = new ChatMessageAssembly(runId)
      const publisher = new ChatMessagePublisher(request.onMessage)
      let finished: Extract<AGUIEvent, { type: 'RUN_FINISHED' }> | undefined
      let failed = false
      try {
        const response = await this.call('/runs', {
          method: 'POST',
          headers: { 'x-keundal-model': selected.id },
          signal: combined,
          body: JSON.stringify({
            threadId: id,
            runId,
            state: { web: chat },
            context: [],
            tools: [],
            messages: [
              { id: randomUUID(), role: 'system', content: instructions(!!request.webSearch) },
              ...toMessages(request.messages, request.model)
            ]
          })
        })
        for await (const event of this.events(response, combined)) {
          projection.apply(event)
          publisher.update(event, projection.message)
          if (event.type === EventType.RUN_FINISHED) finished = event
          else {
            if (event.type === EventType.RUN_ERROR) failed = true
            yield event
          }
        }
        if (!finished && !failed) throw new Error('Keundal generation did not finish')
      } catch (error) {
        if (!combined.aborted && !failed) {
          yield { type: EventType.RUN_ERROR, message: error instanceof Error ? error.message : String(error) }
        }
      } finally {
        try {
          projection.finish(request.model)
          await this.complete(id, runId, projection.message)
          publisher.finish(projection.message)
        } finally {
          this.active.delete(id)
          release()
        }
      }
      if (finished) yield finished
    } catch (error) {
      this.active.delete(id)
      release()
      throw error
    }
  }

  private async* events(response: Response, signal: AbortSignal): AsyncGenerator<AGUIEvent> {
    if (!response.body) throw new Error('Keundal host returned an empty stream')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary >= 0) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of chunk.split('\n')) {
            if (line.startsWith('data: ')) yield JSON.parse(line.slice(6)) as AGUIEvent
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /** 저장된 journal만 다시 그립니다. 호스트의 LLM을 재호출하지 않습니다. */
  async recover() {
    const response = await this.call('/recover', { method: 'POST' })
    const runs = await response.json() as GenerationSnapshot[]
    for (const run of runs) {
      if (run.status === 'running') continue
      const id = run.request.input.threadId
      const snapshot = this.snapshot(await (await this.call(`/threads/${encodeURIComponent(id)}`)).json())
      const chat = this.chat(snapshot)
      if (!chat || chat.pendingRunId !== run.request.input.runId) continue
      const projection = new ChatMessageAssembly(run.request.input.runId)
      for (const entry of run.journal) projection.apply(entry.event)
      projection.finish(chat.model)
      await this.complete(id, run.request.input.runId, projection.message)
    }
  }

  async stop() {
    for (const active of this.active.values()) active.abort.abort()
    await Promise.all([...this.active.values()].map(active => active.done))
  }
}
