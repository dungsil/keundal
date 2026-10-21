import type { ExecutableTool } from '@keundal/agent-contract'
import { z } from 'zod'

import { chartTool } from './chart'
import { weatherTool } from './weather'

export function createChatTools(): ExecutableTool[] {
  return Object.entries({ chart: chartTool, weather: weatherTool }).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema),
    execute: async (args: Record<string, unknown>) =>
      JSON.stringify(await tool.execute(tool.inputSchema.parse(args) as never))
  }))
}
