import { chartSchema } from '@keundal/chat/tools/chart'
import { z } from 'zod'

export const chartTool = {
  description:
    'Create a line chart visualization with one or multiple data series. Use this tool to display time-series data, trends, or comparisons between different metrics over time.',
  inputSchema: chartSchema,
  execute: async ({ title, data, xKey, series, xLabel, yLabel }: z.infer<typeof chartSchema>) => {
    // Create a delay to simulate the input-available state
    await new Promise((resolve) => globalThis.setTimeout(resolve, 1500))

    return {
      title,
      data,
      xKey,
      series,
      xLabel,
      yLabel
    }
  }
}
