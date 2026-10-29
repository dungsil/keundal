import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { AgentConfig } from '@keundal/agent-loop'
import type { ExecutableTool } from '@keundal/tools'
import type { ChatMessage } from '@keundal/chat/chat-message'
import { toMessages } from '@keundal/chat/messages'
import { EventType, type AGUIEvent } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import agentPlugin from '@keundal/plugin-agent-chat'
import { ChatStore } from '@keundal/plugin-chat-local'
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'
import { Context } from 'cordis'
import { IDBFactory } from 'fake-indexeddb'
import { expect, onTestFinished, test } from 'vitest'

import { useKeundalChat } from '../app/lib/use-keundal-chat'

const model = 'openai/gpt-5-nano'
const backends = ['memory', 'indexeddb', 'sqlite'] as const

const userText = (request: LLMRequest) =>
  request.input.messages.flatMap((message) => {
    if (message.role !== 'user') return []
    if (typeof message.content === 'string') return [message.content]
    return message.content.flatMap(part => (part.type === 'text' ? [part.text] : []))
  })

/**
 * 공급자 호출을 대본으로 대신하고 선택한 저장소 플러그인으로 로컬 채팅 저장소를 만듭니다. 제목
 * 요청은 기록하지 않습니다.
 */
async function setup(
  backend: (typeof backends)[number],
  script: (request: LLMRequest, index: number, signal?: AbortSignal) => AsyncIterable<LLMEvent>,
  tools: ExecutableTool[] = []
) {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class ScriptedLLM extends LLMService {
    async getModel() {
      return { contextWindow: 128_000, maxOutputTokens: 4096 }
    }

    async countTokens() {
      return 40
    }

    async* stream(request: LLMRequest, execution?: { signal?: AbortSignal }): AsyncIterable<LLMEvent> {
      if (request.input.messages.some(message => message.role === 'system' && message.content.startsWith('Generate a chat title'))) {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'title', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'title', delta: '제목' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'title' }
        return
      }
      requests.push(request)
      yield* script(request, requests.length - 1, execution?.signal)
    }
  }
  const llm = await ctx.plugin(ScriptedLLM)
  const directory = await mkdtemp(join(tmpdir(), 'keundal-queue-'))
  const store = backend === 'memory'
    ? await ctx.plugin(memoryStorePlugin)
    : backend === 'sqlite'
      ? await ctx.plugin(sqliteStorePlugin, { path: join(directory, 'chat.sqlite') })
      : await ctx.plugin(indexedDBStorePlugin, { indexedDB: new IDBFactory(), databaseName: crypto.randomUUID(), locks: navigator.locks })
  const chats = new ChatStore(ctx, async (child, config: AgentConfig) => child.plugin(agentPlugin, { ...config, tools }))
  onTestFinished(async () => {
    await chats.stop()
    await store.dispose()
    await llm.dispose()
    await rm(directory, { recursive: true, force: true })
  })
  return { ctx, chats, requests }
}

const answer = (text: string): LLMEvent[] => {
  const messageId = crypto.randomUUID()
  return [
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId }
  ]
}

const first: ChatMessage = { id: 'first', role: 'user', parts: [{ type: 'text', text: '첫 질문' }] }

test.each(['legacy', 'success', 'cancelled', 'interrupt', 'unfinished'] as const)('%s 종료에서는 정상 완료일 때만 다음 대기 메시지를 실행한다', async (outcome) => {
  const queued: ChatMessage = { id: 'queued', role: 'user', parts: [{ type: 'text', text: '다음 질문' }] }
  let runs = 0
  const chat = useKeundalChat({
    async *respond() {
      const runId = `run-${++runs}`
      yield { type: EventType.RUN_STARTED, threadId: 'chat', runId }
      if (outcome === 'unfinished') return
      yield {
        type: EventType.RUN_FINISHED, threadId: 'chat', runId,
        ...(outcome === 'legacy' ? {} : { outcome: outcome === 'interrupt'
          ? { type: 'interrupt', interrupts: [{ id: 'approval', reason: 'confirmation', message: '계속할까요?' }] }
          : { type: outcome } })
      } as AGUIEvent
    },
    load: async () => ({ messages: [first], queue: runs === 1 ? [queued] : [] })
  })
  await chat.sendMessage({ text: '첫 질문' })
  const succeeded = outcome === 'legacy' || outcome === 'success'
  expect(runs).toBe(succeeded ? 2 : 1)
  expect(chat.queue.value).toEqual(succeeded ? [] : [queued])
})

function client(chats: ChatStore, id: string) {
  return useKeundalChat({
    respond: (messages, onMessage, signal) => chats.respond(id, { model, messages, onMessage }, signal),
    steer: message => chats.steer(id, message),
    enqueue: message => chats.enqueue(id, message),
    dequeue: messageId => chats.dequeue(id, messageId),
    load: () => chats.get(id)
  })
}

test.each(backends)('%s: 실행 중 받은 여러 Queue 요청을 정상 종료 뒤 순서대로 처리하고 중복 요청은 한 번만 보낸다', async (backend) => {
  const release = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const { chats, requests } = await setup(backend, async function* (request, index) {
    if (index === 0) {
      started.resolve(undefined)
      await release.promise
    }
    yield* answer(`응답:${userText(request).at(-1)}`)
  })
  await chats.create('chat', first, model)
  const chat = client(chats, 'chat')
  chat.messages.value = [first]
  const running = chat.regenerate()
  await started.promise
  await chat.sendMessage({ text: '둘째', mode: 'queue' })
  await chat.sendMessage({ text: '셋째', mode: 'queue' })
  expect(chat.queue.value.map(message => message.parts[0])).toEqual([
    { type: 'text', text: '둘째' },
    { type: 'text', text: '셋째' }
  ])
  // 실행 중 대기열은 종료 커밋 전까지 세션 revision을 바꾸지 않습니다.
  expect((await chats.get('chat'))!.queue).toBeUndefined()
  await expect(chats.enqueue('chat', chat.queue.value[0]!)).resolves.toHaveLength(2)
  release.resolve(undefined)
  await running
  expect(requests.map(request => userText(request).at(-1))).toEqual(['첫 질문', '둘째', '셋째'])
  expect(chat.status.value).toBe('ready')
  expect(chat.queue.value).toEqual([])
  const saved = (await chats.get('chat'))!
  expect(saved.queue).toBeUndefined()
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant'])
  expect(chat.messages.value).toEqual(saved.messages)
})

test.each(backends)('%s: 도구 실행 중 Steer한 지시를 같은 실행의 다음 요청에 반영하고 도구는 한 번만 실행한다', async (backend) => {
  const toolStarted = Promise.withResolvers<undefined>()
  const toolRelease = Promise.withResolvers<undefined>()
  let executed = 0
  const lookup: ExecutableTool = {
    name: 'lookup',
    description: 'lookup',
    parameters: { type: 'object', properties: {} },
    async execute() {
      executed++
      toolStarted.resolve(undefined)
      await toolRelease.promise
      return 'found'
    }
  }
  const { chats, requests } = await setup(backend, async function* (_request, index) {
    if (index === 0) {
      yield { type: EventType.TOOL_CALL_START, toolCallId: 'call', toolCallName: 'lookup' }
      yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call', delta: '{}' }
      yield { type: EventType.TOOL_CALL_END, toolCallId: 'call' }
    } else yield* answer('지시 반영')
  }, [lookup])
  await chats.create('chat', first, model)
  const chat = client(chats, 'chat')
  chat.messages.value = [first]
  const running = chat.regenerate()
  await toolStarted.promise
  await chat.sendMessage({ text: '한국어로 답해', mode: 'steer' })
  await chat.sendMessage({ text: '짧게 답해', mode: 'steer' })
  expect(chat.queue.value).toEqual([])
  toolRelease.resolve(undefined)
  await running
  expect(executed).toBe(1)
  expect(requests).toHaveLength(2)
  const second = requests[1]!.input.messages
  const toolIndex = second.findIndex(message => message.role === 'tool')
  expect(userText({ ...requests[1]!, input: { ...requests[1]!.input, messages: second.slice(toolIndex) } })).toEqual(['한국어로 답해', '짧게 답해'])
  const saved = (await chats.get('chat'))!
  expect(saved.queue).toBeUndefined()
  expect(saved.messages.map(message => [message.role, message.metadata?.steeredRunId !== undefined])).toEqual([
    ['user', false],
    ['assistant', false],
    ['user', true],
    ['user', true]
  ])
  // 반영된 지시는 어시스턴트 기록에 원래 위치로 들어 있으므로 다음 입력에 한 번만 나타납니다.
  const replay = toMessages(saved.messages, model)
  expect(replay.filter(message => message.role === 'user').map(message => message.id)).toEqual([
    first.id,
    saved.messages[2]!.id,
    saved.messages[3]!.id
  ])
  expect(chat.messages.value).toEqual(saved.messages)
})

test.each(backends)('%s: 반영하지 못한 Steer는 대기열 앞에 남고, 중단하면 대기열을 멈춘다', async (backend) => {
  const started = Promise.withResolvers<undefined>()
  let cancelled = false
  const { chats, requests } = await setup(backend, async function* (_request, index, signal) {
    yield* answer('부분 응답').slice(0, 2)
    if (index === 0) {
      started.resolve(undefined)
      // 사용자가 중단할 때까지 모델 요청을 유지합니다.
      const aborted = Promise.withResolvers<undefined>()
      signal?.addEventListener('abort', () => {
        cancelled = true
        aborted.reject(signal.reason)
      }, { once: true })
      await aborted.promise
    }
  })
  await chats.create('chat', first, model)
  const chat = client(chats, 'chat')
  chat.messages.value = [first]
  const running = chat.regenerate()
  await started.promise
  await chat.sendMessage({ text: '대기 메시지', mode: 'queue' })
  // 도구가 없는 실행은 진행 중인 모델 요청을 중단하지 않으므로 지시를 이 실행에 반영하지 않습니다.
  await chat.sendMessage({ text: '반영 못 한 지시', mode: 'steer' })
  await chat.stop()
  await running
  expect(cancelled).toBe(true)
  expect(requests).toHaveLength(1)
  expect(chat.status.value).toBe('ready')
  const saved = (await chats.get('chat'))!
  expect(saved.pendingRunId).toBeUndefined()
  expect(saved.queue?.map(message => message.parts[0])).toEqual([
    { type: 'text', text: '반영 못 한 지시' },
    { type: 'text', text: '대기 메시지' }
  ])
  expect(chat.queue.value).toEqual(saved.queue)
  await chat.removeQueued(saved.queue![1]!.id)
  expect((await chats.get('chat'))!.queue?.map(message => message.id)).toEqual([saved.queue![0]!.id])
})

test('대화별 실행은 서로를 기다리지 않고 같은 대화의 동시 실행은 거부한다', async () => {
  const release = Promise.withResolvers<undefined>()
  const started = Promise.withResolvers<undefined>()
  const { chats } = await setup('memory', async function* (request) {
    if (request.input.threadId === 'busy') {
      started.resolve(undefined)
      await release.promise
    }
    yield* answer('응답')
  })
  await chats.create('busy', first, model)
  await chats.create('other', first, model)
  const busy = client(chats, 'busy')
  busy.messages.value = [first]
  const running = busy.regenerate()
  await started.promise
  const other = client(chats, 'other')
  other.messages.value = [first]
  await other.regenerate()
  expect(other.status.value).toBe('ready')
  expect((await chats.get('other'))!.messages).toHaveLength(2)
  const duplicate = chats.respond('busy', { model, messages: [first] })
  await expect(duplicate.next()).rejects.toThrow('A response is already running')
  release.resolve(undefined)
  await running
  expect((await chats.get('busy'))!.messages).toHaveLength(2)
})
