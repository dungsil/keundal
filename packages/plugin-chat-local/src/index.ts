import { parseRunBudget, type RunBudget } from '@keundal/agent'
import type { ChatMessage, ChatMessageAssembly } from '@keundal/chat/chat-message'
import { branchChat, chatSummary, validateChatTitle } from '@keundal/chat/chat-store'
import type { ChatStoreLike, ChatSummary, LocalChat } from '@keundal/chat/chat-store'
import { parseModelRecoveryPolicy, type ModelRecoveryPolicy } from '@keundal/chat/model-preferences'
import { ChatRuns, createActiveChatRun, settleChatRun, type ActiveChatRun } from '@keundal/chat/run-queue'
import { SteerQueue, type AGUIEvent, type ExecutionOptions } from '@keundal/core'
import { type Reasoning } from '@keundal/llm'
import { parsePromptPreset, type PromptPreset } from '@keundal/prompt'
import { type SessionSnapshot } from '@keundal/session'
import type {} from '@keundal/skill'
import { parseSubagentRoles, type SubagentRole } from '@keundal/subagent'
import { ToolApproval } from '@keundal/tool-approval'
import type { Context } from 'cordis'

import { createKeundalChat, toMessages, type KeundalChatRuntime, type MountAgent } from './keundal'
export type { MountAgent } from './keundal'

type ChatState = { web: LocalChat }
type LocalRun = ActiveChatRun & { steer: SteerQueue; model: string }

/** Uses only Keundal service contracts: swapping the store plugin needs no UI/agent changes. */
export class ChatStore implements ChatStoreLike {
  /** 실행은 브라우저 탭 안에서 진행되므로 탭을 닫으면 실행과 메모리의 대기열이 함께 끝납니다. */
  readonly execution = 'browser'
  private readonly runtimes = new Map<string, { key: string; runtime: KeundalChatRuntime }>()
  private readonly runs = new ChatRuns<LocalRun>({
    read: (id) => this.get(id),
    write: async (id, change) => {
      const snapshot = await this.ctx.session.get(id)
      const chat = this.chat(snapshot)
      if (!chat) throw new Error('Chat not found')
      const next = change(chat)
      await this.save(snapshot, next)
      return next
    }
  })
  private readonly active = this.runs.active

  constructor(
    private readonly ctx: Context,
    private readonly mountAgent: MountAgent,
    private readonly toolApproval: ToolApproval = new ToolApproval({ default: 'allow' })
  ) {}

  async respondToToolApproval(runId: string, requestId: string, decision: 'allow' | 'deny') {
    return this.toolApproval.respond(runId, requestId, decision)
  }

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

  async listSummaries(): Promise<ChatSummary[]> {
    return (await this.list()).map(chatSummary)
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

  private async complete(
    id: string,
    runId: string,
    message: ChatMessage,
    steered: ChatMessageAssembly['steered'],
    active?: ActiveChatRun
  ) {
    const snapshot = await this.ctx.session.get(id)
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

  steer(id: string, message: ChatMessage) {
    return this.runs.steer(id, message, async (run) => {
      const [instruction] = toMessages([message], run.model)
      return !!instruction && run.steer.push([instruction]) > 0
    })
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

  /** 원래 대화는 읽기만 하므로 실행 중에도 허용하며, 새 대화는 한 번의 커밋으로 저장합니다. */
  async branch(sourceId: string, messageId: string, newId: string): Promise<LocalChat> {
    const source = this.chat(await this.ctx.session.get(sourceId))
    if (!source) throw new Error('Chat not found')
    if (await this.ctx.session.get(newId)) throw new Error('Chat already exists')
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
      modelRecovery?: ModelRecoveryPolicy
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
    const modelRecovery =
      request.modelRecovery === undefined ? undefined : parseModelRecoveryPolicy(request.modelRecovery)
    const subagentRoles = request.subagentRoles === undefined ? undefined : parseSubagentRoles(request.subagentRoles)
    const budget = request.budget === undefined ? undefined : parseRunBudget(request.budget)
    const abort = new AbortController()
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    const run: LocalRun = { ...createActiveChatRun(abort, done), steer: new SteerQueue(), model: request.model }
    this.active.set(id, run)
    let runtime: KeundalChatRuntime | undefined
    let settled = false
    try {
      combined.throwIfAborted()
      const snapshot = await this.ctx.session.get(id)
      const current = this.chat(snapshot)
      if (!current) throw new Error('Chat not found')
      const limits = await this.ctx.llm.getModel(request.model, { signal: combined })
      const runId = crypto.randomUUID()
      // 대기열에서 꺼낸 메시지는 대화에 넣는 같은 커밋에서 대기열에서 지워 중복 실행을 막습니다.
      const sent = new Set(request.messages.map((message) => message.id))
      const queue = (current.queue ?? []).filter((message) => !sent.has(message.id))
      let chat: LocalChat = {
        ...current,
        messages: request.messages,
        model: request.model,
        started: true,
        pendingRunId: runId,
        queue: queue.length ? queue : undefined
      }
      const saved = await this.save(snapshot, chat)
      run.runId = runId
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
          runtime: await createKeundalChat(
            this.ctx,
            request.model,
            { ...request, maxOutputTokens, toolApproval: this.toolApproval },
            this.mountAgent
          )
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
        promptPreset,
        modelRecovery,
        ...(budget === undefined ? {} : { budget }),
        signal: combined,
        state: { web: chat, ...(subagentRoles === undefined ? {} : { subagentRoles }) },
        onMessage: request.onMessage,
        instructions: `You are a knowledgeable and helpful AI assistant. Be clear, accurate and concise.
Do not use markdown headings. Use bold text for section labels instead.
${request.webSearch && !request.model.startsWith('google/') ? 'Use native web search when current information is needed and cite sources.' : 'Web search is disabled. Do not claim to have verified live information.'}${request.systemPrompt?.trim() ? `\n\n${request.systemPrompt.trim()}` : ''}`,
        steer: run.steer,
        onFinish: async (message, steered) => {
          // 종료를 확정하는 동안 도착한 지시와 대기 메시지는 이 실행에 붙이지 않고 다음 커밋으로 넘깁니다.
          run.closing = true
          run.steer.close()
          await this.complete(id, runId, message, steered, run)
          settled = true
        }
      })
    } finally {
      run.steer.close()
      try {
        await this.runs.release(id, run, settled)
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
        onFinish: async (message, steered) => {
          await this.complete(id, run.request.input.runId, message, steered)
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
