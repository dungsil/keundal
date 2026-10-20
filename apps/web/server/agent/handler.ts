import type { RequestListener } from 'node:http'
import { createError, defineEventHandler, fromNodeMiddleware } from 'h3'

export function createAgentHandler(getApp: () => Promise<RequestListener>) {
  return defineEventHandler(async (event) => {
    let app: RequestListener
    try {
      app = await getApp()
    } catch {
      throw createError({ statusCode: 503, statusMessage: 'Agent host is unavailable' })
    }
    const request = event.node.req
    const original = request.url
    request.url = (original ?? '/').replace(/^\/api\/agent(?=\/|\?|$)/, '') || '/'
    try {
      return await fromNodeMiddleware((req, res, _next) => app(req, res))(event)
    } finally {
      request.url = original
    }
  })
}
