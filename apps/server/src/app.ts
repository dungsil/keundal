import { Buffer } from 'node:buffer'
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
export function createAgentApp(services: AgentAppServices): RequestListener {
  return async function requestListener(request, response) {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const segments = url.pathname.split('/').filter(Boolean)

    try {
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
      if (!response.headersSent) {
        sendJson(response, 400, { error: 'invalid request' })
      } else if (!response.writableEnded) {
        response.end()
      }
    }
  }
}
