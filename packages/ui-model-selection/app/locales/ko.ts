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
  'model.useChatModel': '채팅 모델 사용',
  'model.noDefault': '마지막으로 선택한 모델 사용',
  'model.defaultSaved': '모델 설정을 저장했습니다.',
  'model.defaultSaveFailed': '모델 설정을 저장하지 못했습니다. 브라우저 저장소를 사용할 수 있는지 확인하세요.',
  'model.refresh': '모델 목록 새로고침',
  'model.cache':
    '공급자의 모델 목록은 이 브라우저에 1시간 동안 저장됩니다. 이 앱의 텍스트·도구·토큰 계산 API를 지원하는 모델만 표시됩니다.'
} satisfies Record<keyof typeof en, string>
