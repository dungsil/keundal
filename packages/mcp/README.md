# @keundal/mcp

MCP 설정 타입, 설정 검증 함수와 `McpSettingsStorage` 계약을 제공합니다. SDK와 클라이언트 구현에는 의존하지 않습니다.

OAuth 자격 증명은 설정과 분리된 `McpCredentialStorage`에 보관합니다. 이 저장소는 앱이 OS 보안 저장소나 서버 측 비밀 저장소로 구현합니다. `McpAuthentication`은 서버 URL, 계정 수명 신호, 토큰 조회와 401 갱신 계약이며, `McpConnectOptions.authentication`으로 클라이언트에 전달합니다. 로그인·콜백·상태·연결 해제의 구현은 클라이언트 패키지의 `McpOAuth`를 사용합니다.

연결과 도구 실행은 [`@keundal/plugin-mcp-client`](../plugin-mcp-client/README.md)를 사용합니다. 브라우저에서는 `@keundal/plugin-mcp-client/browser`를 사용합니다.
