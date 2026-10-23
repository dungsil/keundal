import type en from './en'

export default {
  'plugin.manage': '설치된 플러그인',
  'plugin.description': 'Agent Plugins 1.0.0 폴더를 가져와 웹 대화에서 스킬과 HTTP MCP 도구를 사용합니다.',
  'plugin.unavailable':
    '이 연결에서는 브라우저로 플러그인을 가져올 수 없습니다. 에이전트 호스트에서 플러그인을 설정하세요.',
  'plugin.trustTitle': '신뢰하는 플러그인만 활성화하세요',
  'plugin.notice':
    '가져온 플러그인은 비활성 상태입니다. 활성화 전에 스킬, 서버 주소, 진단을 확인하세요. MCP는 권한을 지정해야 접근할 수 있습니다. 브라우저는 stdio 서버를 실행하지 못합니다. HTTP 서버는 CORS로 이 브라우저의 origin을 허용해야 합니다.',
  'plugin.installed': '이 브라우저에 저장된 플러그인',
  'plugin.import': '폴더 가져오기',
  'plugin.empty': '에이전트 플러그인이 없습니다',
  'plugin.emptyHelp': 'plugin.json이 있는 폴더를 선택하세요. 스킬과 MCP 설정을 함께 가져옵니다.',
  'plugin.enable': '{name} 활성화',
  'plugin.skills': '스킬',
  'plugin.none': '없음',
  'plugin.permissions': 'MCP 권한',
  'plugin.deleteHelp': '이 플러그인과 저장된 권한을 삭제할까요?',
  'plugin.persistence':
    '플러그인 본문과 인증 정보는 이 브라우저에 저장하며 호스트에 업로드하지 않습니다. 설정을 바꾸면 진행 중인 응답을 중단하고 다음 응답부터 적용합니다. 업데이트하려면 플러그인을 삭제한 뒤 폴더를 다시 가져오세요.'
} satisfies Record<keyof typeof en, string>
