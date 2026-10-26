import type en from './en'

export default {
  'runtime.title': '큰달 플러그인',
  'runtime.unavailable': '이 연결에서는 선택 기능을 관리할 수 없습니다.',
  'runtime.bundled': '앱에 포함된 기능 플러그인을 선택합니다. 관련 화면은 기능을 따라 켜지고 꺼지며, UI 플러그인은 따로 전환하지 않습니다. 외부 다운로드는 지원하지 않습니다. 필수 항목은 항상 켜져 있습니다.',
  'runtime.required': '필수',
  'runtime.requiredDescription': '필수 플러그인입니다. 항상 켜져 있으며 끌 수 없습니다.',
  'runtime.enabled': '활성',
  'runtime.disabled': '비활성',
  'runtime.failed': '활성화 실패',
  'runtime.enable': '{name} 활성화',
  'runtime.install': '외부 플러그인 설치',
  'runtime.sourceType': '설치 출처 유형',
  'runtime.package': '패키지 이름 또는 버전 지정자',
  'runtime.absolutePath': '절대 경로',
  'runtime.zip': '로컬 ZIP',
  'runtime.path': '로컬 경로',
  'runtime.localPath': '이 데스크톱에 있는 ZIP 파일이나 플러그인 폴더의 절대 경로를 입력하세요. 브라우저 파일을 업로드하지 않습니다.',
  'runtime.trustTitle': '신뢰하는 플러그인만 설치하세요',
  'runtime.trustWarning': '외부 플러그인의 코드는 호스트 권한으로 실행되며 파일, 인증 정보, 네트워크에 접근할 수 있습니다. 설치한 플러그인은 비활성 상태입니다. 활성화 전에 내용을 확인하세요.',
  'runtime.trust': '이 출처를 신뢰하며 코드가 호스트 권한으로 실행된다는 점을 이해했습니다.',
  'runtime.source': '설치 출처',
  'runtime.version': '버전',
  'runtime.remove': '{name} 삭제',
  'runtime.deleteHelp': '이 외부 플러그인을 데스크톱 호스트에서 삭제할까요?',
  'plugin.unavailable':
    '이 연결에서는 브라우저로 플러그인을 가져올 수 없습니다. 에이전트 호스트에서 플러그인을 설정하세요.',
  'plugin.trustTitle': '신뢰하는 플러그인만 활성화하세요',
  'plugin.notice':
    '가져온 플러그인은 비활성 상태입니다. 활성화 전에 스킬, 서버 주소, 진단을 확인하세요. MCP는 권한을 지정해야 접근할 수 있습니다. 브라우저는 stdio 서버를 실행하지 못합니다. HTTP 서버는 CORS로 이 브라우저의 origin을 허용해야 합니다.',
  'plugin.installed': '이 브라우저에 저장된 플러그인',
  'plugin.import': '폴더 가져오기',
  'plugin.empty': '에이전트 플러그인이 없습니다',
  'plugin.enable': '{name} 활성화',
  'plugin.skills': '스킬',
  'plugin.none': '없음',
  'plugin.permissions': 'MCP 권한',
  'plugin.deleteHelp': '이 플러그인과 저장된 권한을 삭제할까요?',
  'plugin.persistence':
    '플러그인 본문과 인증 정보는 이 브라우저에 저장하며 호스트에 업로드하지 않습니다. 설정을 바꾸면 진행 중인 응답을 중단하고 다음 응답부터 적용합니다. 업데이트하려면 플러그인을 삭제한 뒤 폴더를 다시 가져오세요.'
} satisfies Record<keyof typeof en, string>
