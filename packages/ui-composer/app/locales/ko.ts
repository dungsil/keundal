import type en from './en'

export default {
  'chat.prompt': '무엇이든 물어보세요…',
  'chat.delivery': '실행 중 전송 방식',
  'chat.deliveryQueue': '대기열',
  'chat.deliveryQueueDescription': '현재 응답이 끝난 뒤 순서대로 보냅니다.',
  'chat.deliverySteer': '지시',
  'chat.deliverySteerDescription': '진행 중인 도구가 끝난 뒤 다음 모델 요청에 반영합니다.',
  'chat.stop': '응답 중단',
  'prompt.files': '파일 또는 사진 추가',
  'prompt.search': '웹 검색',
  'prompt.unsupported': '이 모델에서는 지원하지 않습니다.',
  'prompt.menu': '입력 옵션 열기',
  'prompt.commands': '스킬 및 MCP 도구',
  'prompt.commandsLoading': '스킬과 도구를 불러오는 중…',
  'prompt.commandsEmpty': '일치하는 스킬이나 MCP 도구가 없습니다.',
  'prompt.commandsFailed': '스킬과 도구를 불러오지 못했습니다. /를 다시 입력해 재시도하세요.'
} satisfies Record<keyof typeof en, string>
