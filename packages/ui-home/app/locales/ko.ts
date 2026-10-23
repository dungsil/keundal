import type en from './en'

export default {
  'greeting.morning': '좋은 아침이에요',
  'greeting.afternoon': '좋은 오후예요',
  'greeting.evening': '좋은 저녁이에요',
  'suggestion.nuxt': 'Nuxt UI를 사용하면 어떤 점이 좋나요?',
  'suggestion.vue': 'Vue 컴포저블 만드는 것을 도와주세요',
  'suggestion.unjs': 'UnJS에 대해 알려주세요',
  'suggestion.vueuse': 'VueUse를 사용하면 어떤 점이 좋나요?',
  'suggestion.tailwind': 'Tailwind CSS 활용 방법을 알려주세요',
  'suggestion.weather': '보르도의 날씨는 어떤가요?',
  'suggestion.chart': '매출 데이터를 차트로 보여주세요'
} satisfies Record<keyof typeof en, string>
