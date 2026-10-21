import type { ChatMessage } from '@keundal/chat/chat-message'
import { validateChatTitle } from '@keundal/chat/chat-store'
import type { ChatStoreLike, LocalChat } from '@keundal/chat/chat-store'
import type { Reasoning, AGUIEvent, SessionSnapshot, ExecutionOptions } from '@keundal/core'
import type { Context } from 'cordis'

import { createKeundalChat, toMessages } from './keundal'
export type { MountAgent } from './keundal'

type ChatState = { web: LocalChat }

/** Uses only Keundal service contracts: swapping the store plugin needs no UI/agent changes. */
export class ChatStore implements ChatStoreLike {
  private readonly runtimes = new Map<string, { key: string; runtime: Awaited<ReturnType<typeof createKeundalChat>> }>()
  private readonly active = new Map<string, { abort: AbortController; done: Promise<void> }>()

  constructor(
    private readonly ctx: Context,
    private readonly mountAgent: Parameters<typeof createKeundalChat>[3]
  ) {}

  private async trimRuntimes(limit: number) {
    while (this.runtimes.size > limit) {
      const idle = [...this.runtimes.keys()].find((id) => !this.active.has(id))
      if (!idle) return
      const entry = this.runtimes.get(idle)!
      this.runtimes.delete(idle)
      await entry.runtime.dispose()
    }
  }

  private chat(snapshot: SessionSnapshot | undefined): LocalChat | undefined {
    return (snapshot?.state as ChatState | undefined)?.web
  }

  async list(): Promise<LocalChat[]> {
    return (await this.ctx.session.list())
      .flatMap((snapshot) => {
        const chat = this.chat(snapshot)
        return chat ? [chat] : []
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }

  async get(id: string): Promise<LocalChat | undefined> {
    return this.chat(await this.ctx.session.get(id))
  }

  async getRun(runId: string, options: ExecutionOptions = {}) {
    return this.ctx.generation.get(runId, options)
  }

  private async save(snapshot: SessionSnapshot | undefined, chat: LocalChat) {
    return this.ctx.session.commit({
      threadId: chat.id,
      expectedRevision: snapshot?.revision ?? 0,
      mode: 'replace',
      messages: toMessages(chat.messages, chat.model),
      state: { web: chat }
    })
  }

  private async complete(id: string, runId: string, message: ChatMessage) {
    const snapshot = await this.ctx.session.get(id)
    const chat = this.chat(snapshot)
    if (!chat || chat.pendingRunId !== runId) throw new Error('Chat changed while the response was running')
    await this.save(snapshot, { ...chat, messages: [...chat.messages, message], pendingRunId: undefined })
  }

  async create(id: string, message: ChatMessage, model: string): Promise<LocalChat> {
    if (await this.ctx.session.get(id)) throw new Error('Chat already exists')
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
    const snapshot = await this.ctx.session.get(id)
    const chat = this.chat(snapshot)
    if (!chat) throw new Error('Chat not found')
    await this.save(snapshot, change(chat))
  }

  async rename(id: string, title: string) {
    title = validateChatTitle(title)
    await this.update(id, (chat) => ({ ...chat, title }))
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
    const snapshot = await this.ctx.session.get(id)
    await this.ctx.session.delete(id, snapshot?.revision ?? 0)
    await this.runtimes.get(id)?.runtime.dispose()
    this.runtimes.delete(id)
  }

  async *respond(
    id: string,
    request: {
      messages: ChatMessage[]
      model: string
      titleModel?: string
      reasoning?: Reasoning
      webSearch?: boolean
      onMessage?: (message: ChatMessage) => void
      onTitle?: (title: string) => void
    },
    signal?: AbortSignal
  ): AsyncGenerator<AGUIEvent> {
    if (this.active.has(id)) throw new Error('A response is already running')
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    this.active.set(id, { abort, done })
    let runtime: Awaited<ReturnType<typeof createKeundalChat>> | undefined
    try {
      combined.throwIfAborted()
      const snapshot = await this.ctx.session.get(id)
      const current = this.chat(snapshot)
      if (!current) throw new Error('Chat not found')
      const limits = await this.ctx.llm.getModel(request.model, { signal: combined })
      const runId = crypto.randomUUID()
      let chat = { ...current, messages: request.messages, model: request.model, started: true, pendingRunId: runId }
      const saved = await this.save(snapshot, chat)
      const maxOutputTokens = Math.min(4096, limits.maxOutputTokens, limits.contextWindow - 1)
      const key = JSON.stringify([
        request.model,
        request.webSearch,
        request.reasoning,
        maxOutputTokens,
        !!this.ctx.skills
      ])
      let cached = this.runtimes.get(id)
      if (cached && cached.key !== key) {
        await cached.runtime.dispose()
        this.runtimes.delete(id)
        cached = undefined
      }
      if (!cached) {
        await this.trimRuntimes(7)
        cached = {
          key,
          runtime: await createKeundalChat(this.ctx, request.model, { ...request, maxOutputTokens }, this.mountAgent)
        }
        this.runtimes.set(id, cached)
      }
      runtime = cached.runtime
      const titleGenerated = !chat.title
      if (titleGenerated) {
        try {
          chat = {
            ...chat,
            title: validateChatTitle(
              await runtime.title(chat.messages[0]!, combined, request.titleModel || request.model)
            )
          }
          await this.save(saved, chat)
          request.onTitle?.(chat.title!)
        } catch {
          // A title failure must not prevent the chat response.
        }
        combined.throwIfAborted()
      }
      yield* runtime.respond({
        threadId: id,
        runId,
        messages: request.messages,
        signal: combined,
        state: { web: chat },
        onMessage: request.onMessage,
        instructions: `You are a knowledgeable and helpful AI assistant. Be clear, accurate and concise.
Do not use markdown headings. Use bold text for section labels instead.
${request.webSearch && !request.model.startsWith('google/') ? 'Use native web search when current information is needed and cite sources.' : 'Web search is disabled. Do not claim to have verified live information.'}`,
        onFinish: async (message) => {
          await this.complete(id, runId, message)
        }
      })
    } finally {
      this.active.delete(id)
      try {
        await this.trimRuntimes(8)
      } finally {
        release()
      }
    }
  }

  /** Re-render durable journals only. Recovery must never issue a provider request. */
  async recover() {
    for (const run of await this.ctx.generation.recover()) {
      if (run.status === 'running') continue
      const id = run.request.input.threadId
      const snapshot = await this.ctx.session.get(id)
      const chat = this.chat(snapshot)
      if (!chat || chat.pendingRunId !== run.request.input.runId) continue
      const runtime = await createKeundalChat(this.ctx, chat.model, {}, this.mountAgent)
      const events = runtime.respond({
        threadId: id,
        runId: run.request.input.runId,
        messages: chat.messages,
        instructions: '',
        events: (async function* () {
          for (const entry of run.journal) yield entry.event
        })(),
        onFinish: async (message) => {
          await this.complete(id, run.request.input.runId, message)
        }
      })
      try {
        for await (const _event of events) {
          /* Drain the journal projection and persist it. */
        }
      } finally {
        await runtime.dispose()
      }
    }
  }

  async stop() {
    for (const active of this.active.values()) active.abort.abort()
    await Promise.all([...this.active.values()].map((active) => active.done))
    await Promise.all([...this.runtimes.values()].map((entry) => entry.runtime.dispose()))
    this.runtimes.clear()
  }
}
