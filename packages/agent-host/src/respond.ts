import type { ServerResponse } from 'node:http'

export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'private, no-store',
  connection: 'keep-alive'
} as const

/** 오류 값을 HTTP 응답에 넣을 수 있는 짧은 문자열로 바꿉니다. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'unknown error'
}

export const sendJson = (response: ServerResponse, status: number, body: unknown): void => {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'private, no-store'
  })
  response.end(JSON.stringify(body))
}

/** 이벤트 스트림을 열고, 데이터를 SSE 프레임으로 쓰는 함수를 돌려줍니다. */
export function openEventStream(response: ServerResponse) {
  response.writeHead(200, SSE_HEADERS)
  // 보낼 데이터가 아직 없으므로 헤더를 먼저 보내 연결을 확정합니다.
  response.flushHeaders()
  let sequence = 0
  return {
    write(value: unknown): boolean {
      sequence += 1
      return response.write(`id: ${sequence}\ndata: ${JSON.stringify(value)}\n\n`)
    }
  }
}
