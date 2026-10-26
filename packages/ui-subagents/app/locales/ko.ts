import type en from './en'

export default {
  'subagents.title': '서브에이전트',
  'subagents.addRole': '역할 추가',
  'subagents.empty': '추가한 서브에이전트 역할이 없습니다.',
  'subagents.role': '역할 {index}',
  'subagents.name': '이름',
  'subagents.description': '설명',
  'subagents.instructions': '지침',
  'subagents.remove': '삭제',
  'subagents.removeRole': '역할 {index} 삭제',
  'subagents.invalidName': '이름은 영문자, 숫자, 밑줄, 하이픈으로 1~64자 이내로 입력하세요.',
  'subagents.duplicateName': '역할 이름은 중복되지 않아야 합니다.',
  'subagents.invalidDescription': '설명은 1~500자 이내로 입력하세요.',
  'subagents.invalidInstructions': '지침은 1~20,000자 이내로 입력하세요.',
  'subagents.tooManyRoles': '역할은 최대 32개까지 저장할 수 있습니다.',
  'subagents.saved': '서브에이전트 역할을 저장했습니다.',
  'subagents.saveFailed': '서브에이전트 역할을 저장하지 못했습니다. 브라우저 저장소를 사용할 수 있는지 확인한 뒤 다시 시도하세요.'
} satisfies Record<keyof typeof en, string>
