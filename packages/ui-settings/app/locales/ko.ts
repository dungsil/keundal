import type en from './en'

export default {
  'settings.appearance': '화면 설정',
  'settings.colorMode': '컬러 모드',
  'budget.title': '실행 예산',
  'budget.enabled': '요청마다 예산 적용',
  'budget.scope': '저장한 한도는 서브에이전트와 축약을 포함한 새 응답마다 적용합니다. 진행 중인 실행은 바뀌지 않습니다. 끄면 실행 환경의 기본 설정을 사용하고, 한도를 비워 두면 해당 항목은 제한하지 않습니다.',
  'budget.tokens': '입력·출력 토큰 합계',
  'budget.cost': '최대 비용',
  'budget.currency': '통화',
  'budget.duration': '최대 실행 시간(초)',
  'budget.noLimit': '제한 없음',
  'budget.unknownPricing': '가격 미상·통화 불일치 처리',
  'budget.reject': '모델 호출 거부',
  'budget.allow': '허용(비용 한도 보장 안 됨)',
  'budget.warning': '비용은 추정값을 사용합니다. 비용 한도가 있으면 가격 미상 모델은 기본적으로 거부합니다. 허용하면 비용 한도를 보장할 수 없습니다. 이미 발생한 과금과 도구가 수행한 작업은 되돌리지 않습니다.',
  'budget.invalid': '토큰은 양의 정수, 비용은 0 이상과 통화, 시간은 0.001~2,147,483.647초로 입력하세요.',
  'budget.saved': '실행 예산을 저장했습니다.',
  'budget.saveFailed': '실행 예산을 저장하지 못했습니다. 브라우저 저장소를 확인한 뒤 다시 시도하세요.',
  'settings.back': '대화로 돌아가기'
} satisfies Record<keyof typeof en, string>
