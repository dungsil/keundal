import type en from './en'

export default {
  'mcp.name': '서버 이름',
  'mcp.transport': '연결 방식',
  'mcp.command': '실행 명령',
  'mcp.url': '서버 URL',
  'mcp.args': '인자(JSON 배열)',
  'mcp.cwd': '작업 디렉터리(선택 사항)',
  'mcp.env': '환경 변수(JSON 객체)',
  'mcp.headers': 'HTTP 헤더(JSON 객체)',
  'mcp.timeout': '요청 제한 시간(ms)',
  'mcp.edit': '수정',
  'mcp.remove': '삭제',
  'mcp.add': '서버 추가',
  'mcp.save': '변경 사항 저장',
  'mcp.cancel': '취소',
  'mcp.saved': 'MCP 설정을 저장했습니다. 다음 응답부터 적용합니다.',
  'mcp.saveFailed': '저장하거나 연결하지 못했습니다. 서버와 설정, 보안 저장소를 확인하세요.',
  'mcp.invalidJSON': '인자와 인증 정보를 올바른 JSON 형식으로 입력하세요.',
  'mcp.check': '연결 확인',
  'mcp.checkCancel': '확인 취소',
  'mcp.checkDescription':
    '위에 입력한 값으로 서버에 연결해 서버가 알려 주는 도구와 리소스를 조회하고 연결을 닫습니다. 도구는 실행하지 않습니다. 확인에 실패해도 저장할 수 있습니다.',
  'mcp.checkDesktopLimit':
    '데스크톱에서는 Streamable HTTP 서버만 확인할 수 있습니다. 확인은 앱 창에서 요청하므로 서버가 이 앱의 origin을 CORS로 허용해야 합니다. 대화에 응답하는 로컬 호스트는 거치지 않습니다. 확인은 stdio 명령을 실행하지 않습니다.',
  'mcp.checkStdioUnsupported': 'stdio 서버는 여기서 확인할 수 없습니다. 그대로 저장할 수 있습니다.',
  'mcp.checkFailed':
    '서버에 연결하지 못했습니다. 주소와 서버 실행 여부, 서버가 이 앱의 CORS 요청과 MCP 헤더를 허용하는지 확인하세요. 그대로 저장할 수 있습니다.',
  'mcp.checkTimeout': '서버가 {ms}ms 안에 응답하지 않았습니다. 그대로 저장할 수 있습니다.',
  'mcp.checkDetail': '상세 내용: {message}',
  'mcp.checkTools': '서버가 알려 준 도구 ({count})',
  'mcp.checkNoTools': '서버가 알려 주는 도구가 없습니다.',
  'mcp.checkPick': '도구를 선택하면 허용할 도구에 이름을 추가합니다. 이름을 직접 입력할 수도 있습니다.',
  'mcp.checkAllowAll': '*로 모든 도구를 허용 중입니다. 하나를 해제하면 나머지를 이름으로 나열합니다.',
  'mcp.checkUnknown': '허용했지만 서버가 알려 주지 않은 이름: {names}',
  'mcp.checkResources': '리소스: 사용 가능 ({count}개)',
  'mcp.checkNoResources': '리소스: 이 서버는 제공하지 않음',
  'mcp.hosted': '원격 에이전트를 사용 중입니다. 호스트의 KEUNDAL_MCP_SERVERS에서 MCP를 설정하세요.',
  'mcp.webDescription':
    'CORS로 이 브라우저의 origin을 허용한 Streamable HTTP 서버에 연결합니다. 인증 정보를 포함한 설정은 이 브라우저에 저장합니다. 저장하면 진행 중인 응답을 중단합니다.',
  'mcp.allowInsecureHttp': '이 서버의 HTTP 연결 허용',
  'mcp.allowInsecureHttpDescription':
    '신뢰하는 사내망이나 VPN에서만 사용하세요. HTTP는 인증 정보와 MCP 통신 내용을 암호화하지 않습니다.',
  'mcp.desktopDescription':
    'HTTP 서버에 연결하거나 신뢰하는 로컬 stdio 서버를 실행합니다. 설정은 OS 보안 저장소에 저장합니다. 저장하면 진행 중인 응답을 중단하고 로컬 호스트를 다시 시작합니다.'
} satisfies Record<keyof typeof en, string>
