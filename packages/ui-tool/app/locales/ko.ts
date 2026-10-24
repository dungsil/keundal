import type en from './en'

export default {
  'common.unavailable': '정보 없음',
  'tool.subagentPartial': '부분 응답 (작업 미완료)',
  'tool.subagentQueued': '서브에이전트 대기 중',
  'tool.subagentRunning': '서브에이전트 실행 중',
  'tool.subagentCompleted': '서브에이전트 완료',
  'tool.subagentFailed': '서브에이전트 실패',
  'tool.subagentCancelled': '서브에이전트 중단',
  'tool.skillInterrupted': '스킬 불러오기 중단',
  'tool.skillLoading': '스킬 불러오는 중…',
  'tool.skillLoaded': '스킬 불러오기 완료',
  'tool.searching': '웹 검색 중…',
  'tool.searched': '웹 검색 완료',
  'weather.loading': '날씨 정보 불러오는 중…',
  'weather.failed': '날씨 정보를 가져오지 못했습니다. 나중에 다시 시도하세요.',
  'weather.noForecast': '예보 정보가 없습니다.',
  'chart.generating': '차트 생성 중…',
  'chart.failed': '차트를 생성하지 못했습니다. 다시 시도하세요.',
  'chart.loading': '차트 데이터 불러오는 중…',
  'weather.range': '최고 {high}° 최저 {low}°'
} satisfies Record<keyof typeof en, string>
