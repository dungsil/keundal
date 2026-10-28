import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { once } from 'node:events'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { URL } from 'node:url'

import {
  EventType,
  parseAGUIEvent,
  parseRunAgentInput,
  type AGUIEvent,
  type AgentMessage,
  type RunAgentInput
} from '@keundal/core'
import { StreamBudget, parseReasoning } from '@keundal/llm'
import { type SessionCommit } from '@keundal/session'

import type { AgentHostModel, AgentHostRunOptions, AgentHostServices } from './contracts.js'

/** HTTP 계층이 접근하는 에이전트 표면입니다. `@keundal/agent-host`가 이 모양을 만듭니다. */
export interface AgentAppServices extends Omit<AgentHostServices, 'run'> {
  run(input: RunAgentInput, options?: AgentHostRunOptions): AsyncIterable<AGUIEvent>
}

export interface AgentAppOptions {
  /** 모든 HTTP 요청에 필요한 Bearer 토큰입니다. */
  token: string
  /** POST /runs 본문의 최대 바이트 수. 기본값은 8 MiB입니다. */
  maxRequestBodyBytes?: number
  /** 브라우저에서 직접 호출할 때 허용할 origin 목록입니다. 비어 있으면 CORS 헤더를 보내지 않습니다. */
  allowedOrigins?: readonly string[]
}

class RequestBodyTooLargeError extends Error {}

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'private, no-store',
  connection: 'keep-alive'
} as const

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store'
  })
  response.end(JSON.stringify(body))
}

// Summary projections contain only explicitly requested scalar leaves, never object subtrees.
function projectScalarState(state: unknown, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const parts = field.split('.')
    let value: unknown = state
    for (const part of parts) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, part)) {
        value = undefined
        break
      }
      value = (value as Record<string, unknown>)[part]
    }
    if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) continue
    let target = result
    for (const part of parts.slice(0, -1)) {
      if (!target[part] || typeof target[part] !== 'object') target[part] = {}
      target = target[part] as Record<string, unknown>
    }
    target[parts.at(-1)!] = value
  }
  return result
}

const readBody = async (request: IncomingMessage, maxBytes: number): Promise<string> => {
  if (Number(request.headers['content-length']) > maxBytes) {
    request.pause()
    throw new RequestBodyTooLargeError()
  }
  const chunks: Buffer[] = []
  let bytes = 0
  // 기본 async iterator는 조기 종료 시 소켓도 파괴하므로 413 전송까지 유지합니다.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) {
      request.pause()
      throw new RequestBodyTooLargeError()
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

const sseFrame = (sequence: number, event: AGUIEvent): string => `id: ${sequence}\ndata: ${JSON.stringify(event)}\n\n`

const steerBody = (value: unknown): AgentMessage[] => {
  if (typeof value !== 'object' || value === null) throw new Error('invalid steer request')
  const body = value as Record<string, unknown>
  return parseRunAgentInput({
    threadId: 'steer',
    runId: 'steer',
    state: {},
    tools: [],
    context: [],
    messages: body.messages
  }).messages
}

const commitBody = (threadId: string, value: unknown): SessionCommit => {
  if (typeof value !== 'object' || value === null) throw new Error('invalid commit')
  const body = value as Record<string, unknown>
  if (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) {
    throw new Error('invalid revision')
  }
  if (body.mode !== undefined && body.mode !== 'merge' && body.mode !== 'replace') {
    throw new Error('invalid mode')
  }
  const parsed = parseRunAgentInput({
    threadId,
    runId: 'commit',
    state: body.state,
    tools: [],
    context: [],
    messages: body.messages
  })
  return {
    threadId,
    expectedRevision: body.expectedRevision as number,
    ...(body.mode === 'merge' || body.mode === 'replace' ? { mode: body.mode } : {}),
    messages: parsed.messages,
    state: parsed.state
  }
}

const titleBody = (value: unknown): { model: string; message: AgentMessage } => {
  if (typeof value !== 'object' || value === null) throw new Error('invalid title request')
  const body = value as Record<string, unknown>
  if (typeof body.model !== 'string' || !body.model.trim()) throw new Error('invalid model')
  const parsed = parseRunAgentInput({
    threadId: 'title',
    runId: 'title',
    state: {},
    tools: [],
    context: [],
    messages: [body.message]
  })
  const message = parsed.messages[0]
  if (!message) throw new Error('invalid message')
  return { model: body.model, message }
}

const modelId = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value[0] : value)

/** AG-UI 실행과 세션 읽기·쓰기 경로를 HTTP로 노출하는 요청 리스너를 만듭니다. */
export function createAgentApp(services: AgentAppServices, options: AgentAppOptions): RequestListener {
  if (!options?.token || options.token !== options.token.trim() || !/^[A-Za-z0-9\-._~+/]+=*$/.test(options.token)) {
    throw new Error('HTTP 인증 token을 공백 없는 Bearer 토큰으로 설정하세요.')
  }
  const token = Buffer.from(options.token)
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 8 * 1024 * 1024
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new RangeError('maxRequestBodyBytes must be a positive safe integer')
  }
  const allowedOrigins = new Set(options.allowedOrigins ?? [])
  const models = (): readonly AgentHostModel[] => services.models()
  // 실행이 실패한 이유는 journal에 남지 않으므로, 연결된 소비자에게 마지막으로 한 번 전달합니다.
  const terminalErrors = new Map<string, string>()

  const writeEvent = async (
    response: ServerResponse,
    sequence: number | undefined,
    event: AGUIEvent,
    signal: AbortSignal
  ): Promise<void> => {
    signal.throwIfAborted()
    const frame = sequence === undefined ? `data: ${JSON.stringify(event)}\n\n` : sseFrame(sequence, event)
    if (!response.write(frame)) await once(response, 'drain', { signal })
  }

  /**
   * 실행 journal을 afterSequence 다음부터 SSE로 전달합니다. journal 이벤트는 sequence를 SSE id로
   * 붙여 재연결 커서로 쓰게 합니다. 실행이 성공하지 못하고 끝났으면 journal에 남지 않는 RUN_ERROR를
   * id 없이 마지막에 한 번 붙입니다. pending은 같은 요청이 소유한 실행의 소비가 끝나기를 기다립니다.
   */
  const streamRun = async (
    response: ServerResponse,
    runId: string,
    afterSequence: number,
    signal: AbortSignal,
    pending?: Promise<void>
  ): Promise<void> => {
    const budget = new StreamBudget()
    let terminal = false
    try {
      for await (const entry of services.subscribe(runId, { afterSequence, signal })) {
        signal.throwIfAborted()
        const event = parseAGUIEvent(entry.event)
        budget.accept(event)
        await writeEvent(response, entry.sequence, event, signal)
        if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) terminal = true
      }
      signal.throwIfAborted()
      if (terminal) return
      await pending
      const run = await services.generation.get(runId)
      if (!run || run.status === 'completed' || run.status === 'running') return
      const message = terminalErrors.get(runId) ?? `run ${run.status}`
      await writeEvent(response, undefined, { type: EventType.RUN_ERROR, message }, signal)
    } catch (error) {
      // SSE로 응답이 시작된 뒤에는 상태 코드를 바꿀 수 없으므로 오류 이벤트로 마칩니다.
      if (response.writableEnded || response.destroyed || signal.aborted) return
      const message = errorMessage(error).slice(0, 4096)
      await writeEvent(response, undefined, { type: EventType.RUN_ERROR, message }, signal).catch(() => {})
    }
  }

  const openStream = (response: ServerResponse) => {
    const subscription = new AbortController()
    // 연결 종료는 구독만 끊습니다. 실행은 계속되고, 재연결이 afterSequence로 journal을 이어받습니다.
    const disconnect = () => subscription.abort()
    response.once('close', disconnect)
    response.writeHead(200, SSE_HEADERS)
    // 재구독은 다음 이벤트까지 보낼 데이터가 없을 수 있으므로 헤더를 먼저 보내 연결을 확정합니다.
    response.flushHeaders()
    return {
      signal: subscription.signal,
      close() {
        response.off('close', disconnect)
        response.end()
      }
    }
  }

  async function requestListener(request: IncomingMessage, response: ServerResponse) {
    response.setHeader('cache-control', 'private, no-store')
    try {
      const origin = request.headers.origin
      const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : undefined
      if (allowedOrigin) {
        response.setHeader('access-control-allow-origin', allowedOrigin)
        response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
        response.setHeader(
          'access-control-allow-headers',
          'authorization,content-type,x-keundal-model,x-keundal-reasoning'
        )
        response.setHeader('access-control-max-age', '600')
        response.setHeader('vary', 'origin')
      }
      if (request.method === 'OPTIONS') {
        if (origin && !allowedOrigin) return sendJson(response, 403, { error: 'origin not allowed' })
        response.writeHead(204)
        response.end()
        return
      }

      const credentials = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.authorization ?? '')
      const supplied = Buffer.from(credentials?.[1] ?? '')
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
        response.setHeader('WWW-Authenticate', 'Bearer')
        return sendJson(response, 401, { error: 'unauthorized' })
      }

      const url = new URL(request.url ?? '/', 'http://localhost')
      const segments = url.pathname.split('/').filter(Boolean)

      if (request.method === 'GET' && segments.join('/') === 'models') {
        return sendJson(response, 200, { models: models() })
      }

      if (request.method === 'GET' && segments.join('/') === 'catalog') {
        const abort = new AbortController()
        const disconnect = () => abort.abort()
        response.once('close', disconnect)
        try {
          return sendJson(
            response,
            200,
            (await services.catalog?.({ signal: abort.signal })) ?? { skills: [], tools: [] }
          )
        } finally {
          response.off('close', disconnect)
        }
      }

      if (request.method === 'POST' && segments.join('/') === 'runs') {
        const requested = modelId(request.headers['x-keundal-model'])
        if (requested !== undefined && !models().some((model) => model.id === requested)) {
          return sendJson(response, 400, { error: `unknown model: ${requested}` })
        }
        const rawReasoning = modelId(request.headers['x-keundal-reasoning'])
        const reasoning = parseReasoning(
          rawReasoning === 'true' ? true : rawReasoning === 'false' ? false : rawReasoning
        )
        const input = parseRunAgentInput(JSON.parse(await readBody(request, maxRequestBodyBytes)))
        let iterator: AsyncIterator<AGUIEvent>
        try {
          iterator = services.run(input, { model: requested, reasoning })[Symbol.asyncIterator]()
        } catch {
          // 같은 대화나 runId에 실행이 이미 있으면 새 실행을 시작하지 않습니다.
          return sendJson(response, 409, { error: 'run is already active' })
        }
        let started: IteratorResult<AGUIEvent> | undefined
        let startError: unknown
        // 스트림을 열기 전에 연결이 끊기면 클라이언트가 실행 시작을 확인하지 못했으므로 실행을 취소합니다.
        const abandon = () => services.cancel(input.runId)
        response.once('close', abandon)
        try {
          // 첫 이벤트를 받으면 실행이 journal에 등록된 상태이므로 구독을 시작할 수 있습니다.
          started = await iterator.next()
        } catch (error) {
          startError = error
        } finally {
          response.off('close', abandon)
        }
        const stream = openStream(response)
        try {
          if (!started || started.done) {
            const message = (
              startError === undefined ? 'run did not start' : errorMessage(startError) || 'run did not start'
            ).slice(0, 4096)
            await writeEvent(response, undefined, { type: EventType.RUN_ERROR, message }, stream.signal)
            return
          }
          const pump = (async () => {
            try {
              while (!(await iterator.next()).done) {
                // 실행은 journal에 기록되므로 응답과 무관하게 끝까지 소비합니다.
              }
            } catch (error) {
              terminalErrors.set(input.runId, errorMessage(error).slice(0, 4096))
              if (terminalErrors.size > 64) terminalErrors.delete(terminalErrors.keys().next().value!)
            }
          })()
          await streamRun(response, input.runId, -1, stream.signal, pump)
        } finally {
          stream.close()
        }
        return
      }

      if (request.method === 'GET' && segments[0] === 'runs' && segments[2] === 'events' && segments[1]) {
        const runId = segments[1]
        if (!(await services.generation.get(runId))) {
          return sendJson(response, 404, { error: `run not found: ${runId}` })
        }
        const raw = url.searchParams.get('afterSequence')
        const afterSequence = raw === null ? -1 : Number(raw)
        if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
          return sendJson(response, 400, { error: 'invalid afterSequence' })
        }
        const stream = openStream(response)
        try {
          await streamRun(response, runId, afterSequence, stream.signal)
        } finally {
          stream.close()
        }
        return
      }

      if (request.method === 'POST' && segments[0] === 'runs' && segments[2] === 'cancel' && segments[1]) {
        return sendJson(response, 200, { cancelled: services.cancel(segments[1]) })
      }

      if (request.method === 'POST' && segments.length === 4 && segments[0] === 'runs' && segments[2] === 'approvals') {
        const body: unknown = JSON.parse(await readBody(request, maxRequestBodyBytes))
        if (
          !body ||
          typeof body !== 'object' ||
          !('decision' in body) ||
          (body.decision !== 'allow' && body.decision !== 'deny') ||
          Object.keys(body).length !== 1
        ) {
          return sendJson(response, 400, { error: 'invalid approval decision' })
        }
        const accepted = services.respondToToolApproval?.(segments[1]!, segments[3]!, body.decision) ?? false
        return sendJson(response, accepted ? 202 : 409, { accepted })
      }

      if (request.method === 'POST' && segments[0] === 'runs' && segments[2] === 'steer' && segments[1]) {
        const messages = steerBody(JSON.parse(await readBody(request, maxRequestBodyBytes)))
        const queued = services.steer(segments[1], messages)
        return queued
          ? sendJson(response, 202, { queued })
          : sendJson(response, 409, { error: 'run is not active', queued: 0 })
      }

      if (request.method === 'POST' && segments.join('/') === 'title') {
        const requestBody = titleBody(JSON.parse(await readBody(request, maxRequestBodyBytes)))
        if (!models().some((model) => model.id === requestBody.model)) {
          return sendJson(response, 400, { error: `unknown model: ${requestBody.model}` })
        }
        const abort = new AbortController()
        const disconnect = () => abort.abort()
        response.once('close', disconnect)
        try {
          return sendJson(response, 200, { title: await services.title(requestBody, { signal: abort.signal }) })
        } finally {
          response.off('close', disconnect)
        }
      }

      if (request.method === 'GET' && segments[0] === 'threads') {
        if (segments.length === 1) {
          const view = url.searchParams.get('view')
          if (view !== null && view !== 'summary') return sendJson(response, 400, { error: 'invalid view' })
          const fields = (url.searchParams.get('stateFields') ?? '').split(',').filter(Boolean)
          if (
            view === 'summary' &&
            (fields.length > 16 ||
              fields.some(
                (field) =>
                  field.length > 160 ||
                  !field
                    .split('.')
                    .every(
                      (part) =>
                        /^[A-Za-z][A-Za-z0-9_]*$/.test(part) &&
                        !['__proto__', 'prototype', 'constructor'].includes(part)
                    )
              ))
          )
            return sendJson(response, 400, { error: 'invalid stateFields' })
          const snapshots = await services.session.list()
          if (view !== 'summary') return sendJson(response, 200, snapshots)
          return sendJson(
            response,
            200,
            snapshots.map((snapshot) => ({
              threadId: snapshot.threadId,
              revision: snapshot.revision,
              state: projectScalarState(snapshot.state, fields)
            }))
          )
        }
        const snapshot = await services.session.get(segments[1])
        if (!snapshot) return sendJson(response, 404, { error: `thread not found: ${segments[1]}` })
        return sendJson(response, 200, snapshot)
      }

      if (request.method === 'PUT' && segments[0] === 'threads' && segments[1]) {
        const change = commitBody(segments[1], JSON.parse(await readBody(request, maxRequestBodyBytes)))
        return sendJson(response, 200, await services.session.commit(change))
      }

      if (request.method === 'DELETE' && segments[0] === 'threads' && segments[1]) {
        const value = url.searchParams.get('revision')
        const revision = value === null ? Number.NaN : Number(value)
        if (!Number.isSafeInteger(revision) || revision < 0) {
          return sendJson(response, 400, { error: 'invalid revision' })
        }
        await services.session.delete(segments[1], revision)
        response.writeHead(204)
        response.end()
        return
      }

      if (request.method === 'GET' && segments[0] === 'runs') {
        if (segments.length === 1) return sendJson(response, 200, await services.generation.list())
        const snapshot = await services.generation.get(segments[1])
        if (!snapshot) return sendJson(response, 404, { error: `run not found: ${segments[1]}` })
        return sendJson(response, 200, snapshot)
      }

      if (request.method === 'POST' && segments.join('/') === 'recover') {
        return sendJson(response, 200, await services.generation.recover())
      }

      sendJson(response, 404, { error: `no route for ${request.method} ${url.pathname}` })
    } catch (error) {
      if (response.destroyed || response.writableEnded) return
      if (error instanceof RequestBodyTooLargeError && !response.headersSent) {
        // 읽지 않은 본문은 재사용하지 않고, 응답을 전송한 뒤 요청과 소켓을 정리합니다.
        response.setHeader('connection', 'close')
        response.once('finish', () => request.destroy())
        sendJson(response, 413, { error: 'request body too large' })
        return
      }
      if (!response.headersSent) {
        sendJson(response, 400, { error: 'invalid request' })
      } else {
        response.end()
      }
    }
  }

  return (request, response) => {
    // 오류 응답 자체가 실패하더라도 HTTP 서버에 처리되지 않은 Promise 거부를 남기지 않습니다.
    void requestListener(request, response).catch(() => response.destroy())
  }
}
