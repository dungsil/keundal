import { AgentConfigSchema, registerAgent, type AgentConfig } from '@keundal/agent-loop'
import type { Context } from 'cordis'

export const chatAgentPlugin = Object.assign(
  function chatAgentPlugin(ctx: Context, config: AgentConfig) {
    registerAgent(ctx, config)
  },
  { inject: ['llm', 'generation', 'session'], Config: AgentConfigSchema }
)

export default chatAgentPlugin
