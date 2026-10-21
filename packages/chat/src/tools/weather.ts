import { z } from 'zod'

import type { ToolInvocation } from '../chat-message'

export const weatherSchema = z.object({ location: z.string().describe('Location for weather') })
const conditionSchema = z.object({ text: z.string(), icon: z.string() })
export const weatherOutputSchema = z.object({
  location: z.string(),
  temperature: z.number(),
  temperatureHigh: z.number(),
  temperatureLow: z.number(),
  condition: conditionSchema,
  humidity: z.number(),
  windSpeed: z.number(),
  dailyForecast: z.array(z.object({ day: z.string(), high: z.number(), low: z.number(), condition: conditionSchema }))
})
export type WeatherUIToolInvocation = ToolInvocation<{
  input: z.infer<typeof weatherSchema>
  output: z.infer<typeof weatherOutputSchema>
}>
