import agentPlugin from '@keundal/plugin-agent-chat'
import type { Context } from 'cordis'
import type { AgentConfig } from '@keundal/agent-loop'
import { createChatTools } from '@keundal/plugin-tool-chat'

export const mountAgent = async (ctx: Context, config: AgentConfig) => ctx.plugin(agentPlugin, { ...config, tools: createChatTools() })
