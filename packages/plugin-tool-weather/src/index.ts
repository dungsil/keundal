import { weatherSchema } from '@keundal/chat/tools/weather'
import type { ExecutableTool } from '@keundal/tools'
import { z } from 'zod'

export const metadata = {
  name: { en: 'Weather', ko: '날씨' },
  description: {
    en: 'Adds weather lookup and forecasts to conversations.',
    ko: '대화에서 날씨와 예보를 조회할 수 있습니다.'
  }
}

const getWeatherData = (k: string) =>
  ({
    sunny: { text: 'Sunny', icon: 'i-lucide-sun' },
    'partly-cloudy': { text: 'Partly Cloudy', icon: 'i-lucide-cloud-sun' },
    cloudy: { text: 'Cloudy', icon: 'i-lucide-cloud' },
    rainy: { text: 'Rainy', icon: 'i-lucide-cloud-rain' },
    foggy: { text: 'Foggy', icon: 'i-lucide-cloud-fog' }
  })[k] || { text: 'Sunny', icon: 'i-lucide-sun' }

export function createWeatherTools(): ExecutableTool[] {
  return [
    {
      name: 'weather',
      description: 'Get weather info with 5-day forecast',
      parameters: z.toJSONSchema(weatherSchema),
      execute: async (args) => {
        const { location } = weatherSchema.parse(args)
        // Create a delay to simulate the input-available state
        await new Promise((resolve) => globalThis.setTimeout(resolve, 1500))

        const temp = Math.floor(Math.random() * 35) + 5
        const conds = ['sunny', 'partly-cloudy', 'cloudy', 'rainy', 'foggy'] as const
        return JSON.stringify({
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
        })
      }
    }
  ]
}

export default createWeatherTools
