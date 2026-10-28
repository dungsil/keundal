import type en from './en'

export default {
  'prompt.reasoning': '심층 사고',
  'prompt.reasoningLevel': '추론 수준',
  'prompt.reasoningLevel.low': '낮음',
  'prompt.reasoningLevel.medium': '중간',
  'prompt.reasoningLevel.high': '높음',
  'prompt.reasoningLevel.xhigh': '매우 높음',
  'prompt.reasoningLevel.max': '최대',
  'model.select': '모델 선택',
  'model.defaultTitle': '모델 설정',
  'model.defaultLabel': '채팅 모델',
  'model.titleLabel': '제목 생성 모델',
  'model.fallbackChain': '대체 모델 순서 (최대 8개)',
  'model.fallbackCompatibility': '요청에 필요한 도구·추론·검색 기능의 호환성이 확인된 대체 모델만 호출합니다.',
  'model.fallbackPosition': '대체 모델 {count}',
  'model.addFallback': '대체 모델 추가',
  'model.moveUp': '대체 모델 {count} 위로 이동',
  'model.moveDown': '대체 모델 {count} 아래로 이동',
  'model.removeFallback': '대체 모델 {count} 삭제',
  'model.retryPolicy': '다음 실행의 재시도 정책',
  'model.maxRetries': '모델별 재시도 횟수 (0–5)',
  'model.initialDelay': '첫 대기 시간 (ms)',
  'model.maxDelay': '재시도별 최대 대기 시간 (ms)',
  'model.invalidRecovery': '재시도 횟수는 0–5, 대기 시간은 0–60,000 ms의 정수로 입력하세요. 첫 대기 시간은 최대 대기 시간 이하여야 합니다. 대체 모델은 중복 없이 최대 8개까지 지정할 수 있습니다.',
  'model.useChatModel': '채팅 모델 사용',
  'model.noDefault': '마지막으로 선택한 모델 사용',
  'model.defaultSaved': '모델 설정을 저장했습니다.',
  'model.defaultSaveFailed': '모델 설정을 저장하지 못했습니다. 브라우저 저장소를 사용할 수 있는지 확인하세요.',
  'model.refresh': '모델 목록 새로고침',
  'model.cache':
    '공급자의 모델 목록은 이 브라우저에 1시간 동안 저장됩니다. 이 앱의 텍스트·도구·토큰 계산 API를 지원하는 모델만 표시됩니다.'
} satisfies Record<keyof typeof en, string>
