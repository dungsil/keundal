import agentPlugin from '@keundal/agent'
import type { Context } from 'cordis'
import type { AgentConfig } from '@keundal/agent-contract'
import { createChatTools } from '@keundal/chat/tools/agent'

export const mountAgent = async (ctx: Context, config: AgentConfig) => ctx.plugin(agentPlugin, { ...config, tools: createChatTools() })
