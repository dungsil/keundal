import codingAgentPlugin, { type CodingAgentConfig } from '@keundal/plugin-agent-coding'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'

import type { EvaluationCandidate } from '../src/index.ts'

export function codingCandidate(
  identity: { id: string; model: string; revision: string },
  config: Omit<CodingAgentConfig, 'model' | 'tools'>,
  installLLM: (ctx: Context) => Promise<{ dispose(): Promise<void> }>
): EvaluationCandidate {
  return {
    ...identity,
    async create(tools) {
      const ctx = new Context()
      const fibers: { dispose(): Promise<void> }[] = []
      const dispose = async () => {
        const failures = []
        for (const fiber of fibers.reverse()) {
          try {
            await fiber.dispose()
          } catch (error) {
            failures.push(error)
          }
        }
        if (failures.length) throw new AggregateError(failures, 'Candidate cleanup failed')
      }
      try {
        fibers.push(await installLLM(ctx))
        fibers.push(await ctx.plugin(memoryStorePlugin))
        fibers.push(await ctx.plugin(codingAgentPlugin, { ...config, model: identity.model, tools }))
        return { agent: ctx.agent, dispose }
      } catch (error) {
        await dispose()
        throw error
      }
    }
  }
}
