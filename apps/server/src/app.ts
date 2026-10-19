import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { URL } from 'node:url'

import {
  EventType,
  parseAGUIEvent,
  parseRunAgentInput,
  type AGUIEvent,
  type ExecutionOptions,
  type GenerationService,
  type RunAgentInput,
  type SessionService
} from '@keundal/core'

/** HTTP 계층이 접근하는 에이전트 표면입니다. 세 공식 저장소의 서비스가 이 모양을 만족합니다. */
export interface AgentAppServices {
  agent: (input: RunAgentInput, options?: ExecutionOptions) => AsyncIterable<AGUIEvent>
  session: Pick<SessionService, 'get' | 'list'>
  generation: Pick<GenerationService, 'get' | 'list' | 'recover'>
}

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive'
} as const

const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

const sseEvent = (event: AGUIEvent): string => `data: ${JSON.stringify(event)}\n\n`

/** AG-UI 실행과 조회 읽기 경로를 HTTP로 노출하는 요청 리스너를 만듭니다. */
export function createAgentApp(services: AgentAppServices, options: { token: string }): RequestListener {
  if (!options?.token || options.token !== options.token.trim() || !/^[A-Za-z0-9\-._~+/]+=*$/.test(options.token)) {
    throw new Error('HTTP 인증 token을 공백 없는 Bearer 토큰으로 설정하세요.')
  }
  const token = Buffer.from(options.token)

  async function requestListener(request: IncomingMessage, response: ServerResponse) {
    try {
      const credentials = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(request.headers.authorization ?? '')
      const supplied = Buffer.from(credentials?.[1] ?? '')
      if (supplied.length !== token.length || !timingSafeEqual(supplied, token)) {
        response.setHeader('WWW-Authenticate', 'Bearer')
        return sendJson(response, 401, { error: 'unauthorized' })
      }

      const url = new URL(request.url ?? '/', 'http://localhost')
      const segments = url.pathname.split('/').filter(Boolean)

      if (request.method === 'POST' && segments.join('/') === 'runs') {
        const input = parseRunAgentInput(JSON.parse(await readBody(request)))
        response.writeHead(200, SSE_HEADERS)
        try {
          for await (const raw of services.agent(input, {})) {
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

      if (request.method === 'GET' && segments[0] === 'threads') {
        if (segments.length === 1) return sendJson(response, 200, await services.session.list())
        const snapshot = await services.session.get(segments[1])
        if (!snapshot) return sendJson(response, 404, { error: `thread not found: ${segments[1]}` })
        return sendJson(response, 200, snapshot)
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
    } catch {
      if (response.destroyed || response.writableEnded) return
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
