import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { URL } from 'node:url'

import type { AgentHostModel, AgentHostRunOptions, AgentHostServices } from '@keundal/agent-host'
import {
  EventType,
  parseAGUIEvent,
  parseRunAgentInput,
  type AGUIEvent,
  type AgentMessage,
  type RunAgentInput,
  type SessionCommit
} from '@keundal/core'

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

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive'
} as const

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
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

const sseEvent = (event: AGUIEvent): string => `data: ${JSON.stringify(event)}\n\n`

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

  async function requestListener(request: IncomingMessage, response: ServerResponse) {
    try {
      const origin = request.headers.origin
      const allowedOrigin = origin && allowedOrigins.has(origin) ? origin : undefined
      if (allowedOrigin) {
        response.setHeader('access-control-allow-origin', allowedOrigin)
        response.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS')
        response.setHeader('access-control-allow-headers', 'authorization,content-type,x-keundal-model')
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

      if (request.method === 'POST' && segments.join('/') === 'runs') {
        const requested = modelId(request.headers['x-keundal-model'])
        if (requested !== undefined && !models().some((model) => model.id === requested)) {
          return sendJson(response, 400, { error: `unknown model: ${requested}` })
        }
        const input = parseRunAgentInput(JSON.parse(await readBody(request, maxRequestBodyBytes)))
        response.writeHead(200, SSE_HEADERS)
        try {
          for await (const raw of services.run(input, requested === undefined ? {} : { model: requested })) {
            const event = parseAGUIEvent(raw)
            response.write(sseEvent(event))
            if (event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR) break
          }
        } catch (error) {
          // SSE로 응답이 시작된 뒤에는 상태 코드를 바꿀 수 없으므로 오류 이벤트로 마칩니다.
          if (!response.writableEnded) {
            response.write(
              sseEvent({
                type: EventType.RUN_ERROR,
                message: String((error as Error)?.message ?? error)
              })
            )
          }
        } finally {
          response.end()
        }
        return
      }

      if (request.method === 'POST' && segments.join('/') === 'title') {
        const requestBody = titleBody(JSON.parse(await readBody(request, maxRequestBodyBytes)))
        if (!models().some((model) => model.id === requestBody.model)) {
          return sendJson(response, 400, { error: `unknown model: ${requestBody.model}` })
        }
        return sendJson(response, 200, { title: await services.title(requestBody) })
      }

      if (request.method === 'GET' && segments[0] === 'threads') {
        if (segments.length === 1) return sendJson(response, 200, await services.session.list())
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
