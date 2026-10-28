# @keundal/plugin-chat-browser

브라우저 localStorage에 LLM 설정을 저장하고 다른 탭의 변경을 구독합니다. OS 보안 저장소 구현과 독립적입니다.

`./mcp`의 `McpManager`는 주입받은 `McpSettingsStorage`로 설정을 저장하고 연결 수명을 관리합니다. 웹은 `createBrowserMcpSettingsStorage`로 localStorage를 선택합니다. 데스크톱은 `@keundal/plugin-chat-desktop/mcp`의 `createNativeMcpSettingsStorage`로 보안 저장소를 선택합니다. 플랫폼이 저장소와 stdio 허용 여부를 조립합니다.

`McpManager.probe(config, { signal })`는 저장하지 않은 설정을 검증한 뒤 임시 연결로 도구 목록을 조회합니다. 저장된 설정, 저장소, 진행 중인 응답의 연결에는 영향을 주지 않습니다. Streamable HTTP만 확인하며 stdio 설정은 연결하기 전에 거부합니다.

`new McpManager(settingsStorage, { authentication: { issues: account } })`로 서버 이름에 대응하는 `McpAuthentication`을 주입합니다. 연결과 `probe()`가 같은 계정 컨트롤러를 사용하며 자격 증명은 서버 설정에 직렬화하지 않습니다. OAuth 로그인·콜백과 보안 저장소는 앱에서 조립합니다. 설정을 localStorage에 저장하더라도 OAuth 저장소로 재사용하지 않습니다. 계정 연결을 해제하거나 재인증한 뒤에는 `manager.close()`로 캐시를 비우고 다음 조회에서 새 연결을 만듭니다. 자세한 계정 수명과 저장소 경계는 [MCP 클라이언트 문서](../plugin-mcp-client/README.md#oauth-계정-연결)를 참고합니다.

`BrowserMcpOAuth`는 기본 웹 앱의 계정 연결을 담당합니다. `McpManager`의 `oauth`와 `getAuthentication`에 같은 관리자를 연결합니다. 로그인 팝업은 사용자 클릭에서 열며 `/mcp/oauth-callback.html`로 돌아온 전체 URL을 검증합니다. 팝업을 닫거나 설정 화면을 떠나면 미완료 로그인을 취소합니다. 계정 변경은 기존 MCP 연결을 닫습니다. 자격 증명은 현재 앱 인스턴스의 메모리에만 보관하며 새로고침이나 앱 종료 후에는 다시 로그인합니다. MCP 서버와 인증 서버가 앱 origin의 CORS 요청을 허용해야 합니다.

MCP SDK는 도구 조회·연결 확인 또는 OAuth 상태 조회·로그인에 필요할 때 불러옵니다. 서버 설정을 읽는 작업은 SDK를 불러오지 않습니다. SDK를 불러오는 동안 관리자를 닫으면 대기 중인 연결도 취소합니다.

`./skills`의 `SkillManager`는 스킬 설정 저장과 파일 로딩을 담당합니다. 스키마와 타입은 `@keundal/chat/skills`에서 가져옵니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
