import {
  CONTEXT_MESSAGE_PREFIX,
  RequestContextService,
  type ContextOptions,
  type ContextProvider
} from '@keundal/context'
import { parseRunAgentInput, type RunAgentInput } from '@keundal/core'
import type { Context } from 'cordis'

export * from './file-reference.js'
export * from './session-reference.js'
export * from './time-context.js'
export * from './harness-dev-context.js'

export interface RequestContextConfig {
  readonly providers: readonly ContextProvider[]
}

export class OrderedRequestContextService extends RequestContextService {
  private readonly providers: readonly ContextProvider[]

  constructor(ctx: Context, config: RequestContextConfig) {
    super(ctx)
    if (!Array.isArray(config.providers) || config.providers.some((provider) => typeof provider !== 'function')) {
      throw new Error('context providers must be an array of functions')
    }
    this.providers = [...config.providers]
  }

  override async prepare(input: RunAgentInput, options: ContextOptions): Promise<RunAgentInput> {
    options.signal?.throwIfAborted()
    let current = input
    for (const provider of this.providers) {
      const next = parseRunAgentInput(await provider(current, options))
      options.signal?.throwIfAborted()
      if (next.threadId !== input.threadId || next.runId !== input.runId) {
        throw new Error('context preparation must preserve threadId and runId')
      }
      const previousIds = new Set(current.messages.map((message) => message.id))
      const ids = new Set<string>()
      for (const message of next.messages) {
        if (ids.has(message.id)) throw new Error(`duplicate context message id: ${message.id}`)
        ids.add(message.id)
        if (
          !previousIds.has(message.id) &&
          (!message.id.startsWith(CONTEXT_MESSAGE_PREFIX) ||
            message.role !== 'user' ||
            typeof message.content !== 'string')
        ) {
          throw new Error('context providers may only add reserved user text messages')
        }
      }
      if (current.messages.some((message) => !ids.has(message.id))) {
        throw new Error('context providers must preserve existing messages')
      }
      current = next
    }
    return current
  }
}

export function contextPlugin(ctx: Context, config: RequestContextConfig): void {
  new OrderedRequestContextService(ctx, config)
}

export default contextPlugin
