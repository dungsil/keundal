import { toWebRequest } from 'h3'

/**
 * Keundal HTTP 호스트를 같은 origin의 `/api/agent/**`로 노출합니다.
 * 브라우저는 호스트 토큰을 받지 않고, Nitro가 서버 측에서 Bearer 토큰을 붙입니다.
 */
export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig(event)
  if (!config.agentUrl) {
    throw createError({
      statusCode: 503,
      statusMessage: 'Agent host is not configured',
      message: 'Set NUXT_AGENT_URL to the Keundal HTTP host.'
    })
  }
  const path = event.path.replace(/^\/api\/agent/, '').replace(/^\/+/, '')
  const target = new URL(path, config.agentUrl.endsWith('/') ? config.agentUrl : `${config.agentUrl}/`)
  const request = toWebRequest(event)
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('authorization')
  if (config.agentToken) headers.set('authorization', `Bearer ${config.agentToken}`)
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    // @ts-expect-error Node fetch requires half duplex for a streamed request body.
    duplex: 'half',
    signal: request.signal
  })
  return new Response(response.body, {
    status: response.status,
    headers: response.headers
  })
})
