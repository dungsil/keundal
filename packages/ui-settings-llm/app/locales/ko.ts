import type en from './en'

export default {
  'common.key': '키',
  'common.value': '값',
  'llm.title': 'LLM 설정',
  'llm.providerType': '공급자 종류',
  'llm.addProvider': '공급자 추가',
  'llm.invalidName': '공급자 이름은 100자 이내로 입력하세요.',
  'llm.providerName': '공급자 이름',
  'llm.noProviders': '등록된 공급자가 없습니다. 사용할 공급자를 추가하세요.',
  'llm.registeredProviders': '등록된 공급자',
  'llm.configureProvider': '설정 계속하기',
  'llm.provider': '공급자',
  'llm.apiKey': 'API 키',
  'llm.apiKeyPlaceholder': 'API 키를 입력하세요',
  'llm.baseURL': 'API 기본 URL (선택)',
  'llm.baseURLDescription':
    '공식 엔드포인트를 사용하려면 비워 두세요. 사용자 지정 엔드포인트는 API 키를 전달받으며 브라우저 CORS를 지원해야 합니다.',
  'llm.modelsDescription':
    '저장하면 이 공급자의 모델 목록을 자동으로 불러옵니다. 대화 입력창에서 사용할 모델을 선택하세요.',
  'llm.headers': '요청 헤더 (선택)',
  'llm.headersDescription':
    '사용자 지정 헤더는 모델 목록 조회를 비롯한 HTTP 요청에서 공급자의 기본 헤더보다 우선합니다. 엔드포인트에서 CORS로 해당 헤더를 허용해야 하며, 브라우저가 금지한 헤더는 설정할 수 없습니다. WebSocket 연결에는 사용자 지정 헤더를 사용할 수 없습니다.',
  'llm.addHeader': '헤더 추가',
  'llm.headerKeyRequired': '모든 요청 헤더 값에 키를 입력하세요.',
  'llm.duplicateHeaders': '요청 헤더 이름이 중복됩니다.',
  'llm.removed': '공급자 설정을 삭제했습니다.',
  'llm.savedOS': '운영체제 보안 저장소에 설정을 저장했습니다.',
  'llm.savedBrowser': '이 브라우저에 설정을 저장했습니다.',
  'llm.saveFailedOS':
    '설정을 저장하거나 적용하지 못했습니다. 운영체제 보안 저장소와 로컬 호스트를 확인한 뒤 다시 시도하세요.',
  'llm.saveFailedBrowser': '설정을 저장하지 못했습니다. 브라우저 저장소를 사용할 수 있는지 확인하세요.',
  'llm.descriptionOS': '설정은 운영체제 보안 저장소에 저장됩니다. 요청은 공급자에게 직접 전송됩니다.',
  'llm.descriptionBrowser': 'API 키는 이 브라우저에 저장됩니다. 요청은 공급자에게 직접 전송됩니다.',
  'llm.protectedOS': '운영체제 보안 저장소로 보호됩니다',
  'llm.browserWarning': '브라우저 저장소는 보안 저장소가 아닙니다',
  'llm.storageOS':
    'API 키·URL·헤더는 localStorage 대신 macOS Keychain, Windows 자격 증명 관리자 또는 Linux Secret Service에 저장됩니다. 사용 중에는 앱 메모리에 설정이 보관되며, 계정과 동기화되지 않습니다.',
  'llm.storageBrowser':
    '키와 헤더는 localStorage에 암호화되지 않은 상태로 저장됩니다. 이 사이트의 스크립트와 브라우저 확장 프로그램이 읽을 수 있으므로 공용 브라우저에서는 사용하지 마세요. 설정은 계정과 동기화되지 않습니다.',
  'llm.forget': '공급자 설정 삭제',
  'llm.saveOS': '운영체제 보안 저장소에 저장',
  'llm.saveBrowser': '이 브라우저에 저장',
  'llm.headerKey': '헤더 {index} 키',
  'llm.headerValue': '헤더 {index} 값',
  'llm.removeHeader': '헤더 {index} 삭제',
  'llm.invalidKey': 'API 키는 줄바꿈 없이 4096자 이내로 입력하세요.',
  'llm.invalidURL': '인증 정보, 쿼리, 프래그먼트가 없는 HTTPS API URL을 입력하세요. localhost는 HTTP도 허용됩니다.',
  'llm.invalidHeaders':
    '중복되지 않는 HTTP 헤더 이름과 줄바꿈이 없는 ASCII 값을 입력하세요. 값은 각각 4096자 이내여야 합니다.'
} satisfies Record<keyof typeof en, string>
