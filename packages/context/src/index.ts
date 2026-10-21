import type { RunAgentInput } from '@keundal/core'
import { Service, type Context } from 'cordis'

import type { ContextOptions } from './types.js'

export * from './types.js'
export * from './file-reference.js'
export * from './session-reference.js'

export abstract class RequestContextService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'requestContext')
  }

  abstract prepare(input: RunAgentInput, options: ContextOptions): Promise<RunAgentInput>
}

declare module 'cordis' {
  interface Context {
    readonly requestContext: RequestContextService
  }
}
