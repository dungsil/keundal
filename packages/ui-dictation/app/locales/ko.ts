import type en from './en'

export default {
  'dictation.unsupported': '이 브라우저에서는 음성 입력을 지원하지 않습니다.',
  'dictation.dictate': '음성 입력',
  'dictation.failed': '음성 입력 실패',
  'dictation.cancel': '음성 입력 취소',
  'dictation.finish': '음성 입력 완료',
  'dictation.denied': '마이크 접근이 거부되었습니다.'
} satisfies Record<keyof typeof en, string>
