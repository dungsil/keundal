import type { ToolInvocation } from '../chat-message'
import { z } from 'zod'

export type WeatherUIToolInvocation = ToolInvocation<{ input: z.infer<typeof weatherSchema>, output: Awaited<ReturnType<typeof weatherTool.execute>> }>

const getWeatherData = (k: string) => ({
  'sunny': { text: 'Sunny', icon: 'i-lucide-sun' },
  'partly-cloudy': { text: 'Partly Cloudy', icon: 'i-lucide-cloud-sun' },
  'cloudy': { text: 'Cloudy', icon: 'i-lucide-cloud' },
  'rainy': { text: 'Rainy', icon: 'i-lucide-cloud-rain' },
  'foggy': { text: 'Foggy', icon: 'i-lucide-cloud-fog' }
}[k] || { text: 'Sunny', icon: 'i-lucide-sun' })

const weatherSchema = z.object({ location: z.string().describe('Location for weather') })

export const weatherTool = {
  description: 'Get weather info with 5-day forecast',
  inputSchema: weatherSchema,
  execute: async ({ location }: z.infer<typeof weatherSchema>) => {
    // Create a delay to simulate the input-available state
    await new Promise(resolve => setTimeout(resolve, 1500))

    const temp = Math.floor(Math.random() * 35) + 5
    const conds = ['sunny', 'partly-cloudy', 'cloudy', 'rainy', 'foggy'] as const
    return {
      location,
      temperature: Math.round(temp),
      temperatureHigh: Math.round(temp + Math.random() * 5 + 2),
      temperatureLow: Math.round(temp - Math.random() * 5 - 2),
      condition: getWeatherData(conds[Math.floor(Math.random() * conds.length)]!),
      humidity: Math.floor(Math.random() * 60) + 20,
      windSpeed: Math.floor(Math.random() * 25) + 5,
      dailyForecast: ['Today', 'Tomorrow', 'Thu', 'Fri', 'Sat'].map((day, i) => ({
        day,
        high: Math.round(temp + Math.random() * 8 - 2),
        low: Math.round(temp - Math.random() * 8 - 3),
        condition: getWeatherData(conds[(Math.floor(Math.random() * conds.length) + i) % conds.length]!)
      }))
    }
  }
}
