import type en from './en'

export default {
  'runtime.title': '큰달 플러그인',
  'runtime.add': '플러그인 추가',
  'runtime.unavailable': '이 원격 연결에서는 플러그인을 설치할 수 없습니다. 해당 호스트에서 관리하세요.',
  'runtime.trustTitle': '플러그인은 앱의 권한으로 코드를 실행합니다',
  'runtime.browserTrust': '신뢰하는 코드만 활성화하세요. 브라우저 플러그인은 이 origin의 데이터와 인증 정보에 접근할 수 있습니다. 서버는 브라우저용 ESM을 제공하고 CORS로 이 origin을 허용해야 합니다. 비활성화해도 플러그인이 외부에 적용한 변경은 되돌리지 않습니다.',
  'runtime.nodeTrust': '신뢰하는 코드만 활성화하세요. desktop 플러그인은 로컬 호스트에서 실행하며 파일, 인증 정보, 네트워크에 접근할 수 있습니다. 비활성화해도 플러그인이 외부에 적용한 변경은 되돌리지 않습니다.',
  'runtime.browserModule': 'ESM URL',
  'runtime.nodeModule': 'npm 패키지 또는 모듈의 절대 경로',
  'runtime.export': '내보내기 이름',
  'runtime.config': '설정 (JSON)',
  'runtime.configObject': '설정은 JSON 객체여야 합니다.',
  'runtime.trustConsent': '플러그인 출처를 신뢰하며 접근 권한을 확인했습니다.',
  'runtime.install': '설치',
  'runtime.browserInstall': '설치는 코드를 실행하지 않고 URL을 저장합니다. 활성화할 때 모듈을 내려받아 실행하며 오프라인용 복사본은 저장하지 않습니다.',
  'runtime.nodeInstall': '패키지는 설치 스크립트를 실행하지 않고 설치합니다. 패키지 설치에는 Node.js와 npm이 필요합니다. 로컬 모듈은 파일을 복사하지 않고 경로를 등록합니다. 새 플러그인은 비활성 상태입니다.',
  'runtime.empty': '설치한 큰달 플러그인이 없습니다',
  'runtime.enabled': '활성',
  'runtime.disabled': '설치됨 · 비활성',
  'runtime.failed': '활성화 실패',
  'runtime.enable': '{name} 활성화',
  'runtime.remove': '{name} 삭제',
  'runtime.removeConfirm': '앱에서 이 플러그인을 삭제할까요? 플러그인이 저장한 데이터는 삭제하지 않습니다.',
  'runtime.persistence': '설정을 바꾸면 진행 중인 응답을 중단합니다. 비활성화해도 설치 설정은 유지합니다. 필수 서비스와 배포 매니페스트는 별도로 관리하며 대화 기록은 유지합니다.',
  'plugin.manage': '설치된 플러그인',
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
