import type en from './en'

export default {
  'tool.subagentBackground': '백그라운드 작업 등록됨',
  'tool.backgroundTasks': '백그라운드 작업 보기',
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
  'tool.searched': '웹 검색 완료'
} satisfies Record<keyof typeof en, string>
