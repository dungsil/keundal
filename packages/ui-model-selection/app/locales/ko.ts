import type en from './en'

export default {
  'prompt.reasoning': '심층 사고',
  'prompt.reasoningLevel': '추론 수준',
  'model.select': '모델 선택',
  'model.defaultTitle': '모델 설정',
  'model.defaultLabel': '채팅 모델',
  'model.defaultDescription':
    '앱을 열거나 새 대화를 시작할 때 사용할 모델입니다. 이 기기에 저장됩니다. 공급자 설정을 먼저 저장하면 모델 목록을 불러옵니다.',
  'model.titleLabel': '제목 생성 모델',
  'model.titleDescription': '새 대화의 제목을 자동으로 생성할 모델입니다. 이 기기에 저장됩니다.',
  'model.useChatModel': '채팅 모델 사용',
  'model.noDefault': '마지막으로 선택한 모델 사용',
  'model.defaultSaved': '모델 설정을 저장했습니다.',
  'model.defaultSaveFailed': '모델 설정을 저장하지 못했습니다. 브라우저 저장소를 사용할 수 있는지 확인하세요.',
  'model.refresh': '모델 목록 새로고침',
  'model.cache':
    '공급자의 모델 목록은 이 브라우저에 1시간 동안 저장됩니다. 이 앱의 텍스트·도구·토큰 계산 API를 지원하는 모델만 표시됩니다.'
} satisfies Record<keyof typeof en, string>
