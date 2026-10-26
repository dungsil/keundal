import { chartSchema } from '@keundal/chat/tools/chart'
import type { ExecutableTool } from '@keundal/tools'
import { z } from 'zod'

export const metadata = {
  name: { en: 'Charts', ko: '차트' },
  description: {
    en: 'Adds chart visualizations to conversations.',
    ko: '대화에서 데이터를 차트로 표시할 수 있습니다.'
  }
}

export function createChartTools(): ExecutableTool[] {
  return [
    {
      name: 'chart',
      description:
        'Create a line chart visualization with one or multiple data series. Use this tool to display time-series data, trends, or comparisons between different metrics over time.',
      parameters: z.toJSONSchema(chartSchema),
      execute: async (args) => {
        const { title, data, xKey, series, xLabel, yLabel } = chartSchema.parse(args)
        // Create a delay to simulate the input-available state
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1500))

        return JSON.stringify({ title, data, xKey, series, xLabel, yLabel })
      }
    }
  ]
}

export default createChartTools
