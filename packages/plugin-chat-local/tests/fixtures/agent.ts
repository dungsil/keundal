import type { AgentConfig } from '@keundal/agent-loop'
import agentPlugin from '@keundal/plugin-agent-chat'
import { createChartTools } from '@keundal/plugin-tool-chart'
import { createWeatherTools } from '@keundal/plugin-tool-weather'
import type { Context } from 'cordis'

export const mountAgent = async (ctx: Context, config: AgentConfig) =>
  ctx.plugin(agentPlugin, { ...config, tools: [...createChartTools(), ...createWeatherTools()] })
