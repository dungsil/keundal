import type { AGUIEvent, ExecutionOptions, RunAgentInput } from '@keundal/core'
import { Service, type Context } from 'cordis'

declare module 'cordis' {
  interface Context {
    readonly agent: AgentService
  }
}
export abstract class AgentService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'agent')
  }
  abstract run(input: RunAgentInput, options?: ExecutionOptions): AsyncIterableIterator<AGUIEvent>
}
