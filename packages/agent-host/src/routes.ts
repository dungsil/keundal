import type { IncomingMessage, ServerResponse } from 'node:http'
import type { URL } from 'node:url'

import { Service, type Context } from 'cordis'

export interface HostHttpRequest {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly url: URL
  readonly segments: readonly string[]
  /** Reads the body with the host's configured size limit. */
  readonly body: () => Promise<string>
  readonly signal: AbortSignal
}

export interface HostHttpRoute {
  handle(request: HostHttpRequest): Promise<void>
  /** Optional narrowly scoped access, such as an expiring read-only resource ticket. */
  authorize?(request: Pick<HostHttpRequest, 'request' | 'url'>): boolean
}

declare module 'cordis' {
  interface Context {
    readonly hostHttp: HostHttpService
  }
}

/** Feature plugins own a top-level route namespace and release it with their scope. */
export class HostHttpService extends Service {
  private readonly routes = new Map<string, HostHttpRoute>()

  constructor(ctx: Context) {
    super(ctx, 'hostHttp')
  }

  register(ctx: Context, namespace: string, route: HostHttpRoute): () => void {
    if (!/^[a-z][a-z0-9-]*$/.test(namespace)) throw new TypeError('invalid route namespace')
    if (['models', 'catalog', 'runs', 'title', 'threads', 'recover'].includes(namespace)) {
      throw new Error('host route namespace is reserved')
    }
    if (this.routes.has(namespace)) throw new Error(`route namespace already registered: ${namespace}`)
    return ctx.effect(() => {
      this.routes.set(namespace, route)
      return () => {
        this.routes.delete(namespace)
      }
    })
  }

  resolve(url: URL): HostHttpRoute | undefined {
    return this.routes.get(url.pathname.split('/').filter(Boolean)[0] ?? '')
  }
}
