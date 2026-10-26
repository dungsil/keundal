import type { ExecutableTool } from '@keundal/tools'
import { z } from 'zod'

import { chartTool } from './chart'
import { weatherTool } from './weather'

export const metadata = {
  name: { en: 'Weather and charts', ko: '날씨와 차트' },
  description: {
    en: 'Adds weather lookup and chart tools to conversations.',
    ko: '대화에서 날씨 조회와 차트 도구를 사용할 수 있습니다.'
  }
}

export function createChatTools(): ExecutableTool[] {
  return Object.entries({ chart: chartTool, weather: weatherTool }).map(([name, tool]) => ({
    name,
    description: tool.description,
    parameters: z.toJSONSchema(tool.inputSchema),
    execute: async (args: Record<string, unknown>) =>
      JSON.stringify(await tool.execute(tool.inputSchema.parse(args) as never))
  }))
}
