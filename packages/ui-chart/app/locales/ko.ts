import type en from './en'

export default {
  'common.unavailable': '정보 없음',
  'chart.generating': '차트 생성 중…',
  'chart.failed': '차트를 생성하지 못했습니다. 다시 시도하세요.',
  'chart.loading': '차트 데이터 불러오는 중…'
} satisfies Record<keyof typeof en, string>
