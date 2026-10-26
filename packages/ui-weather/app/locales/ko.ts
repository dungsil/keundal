import type en from './en'

export default {
  'weather.loading': '날씨 정보 불러오는 중…',
  'weather.failed': '날씨 정보를 가져오지 못했습니다. 나중에 다시 시도하세요.',
  'weather.noForecast': '예보 정보가 없습니다.',
  'weather.range': '최고 {high}° 최저 {low}°'
} satisfies Record<keyof typeof en, string>
