# @keundal/plugin-chat-browser

브라우저 localStorage에 LLM 설정을 저장하고 다른 탭의 변경을 구독합니다. OS 보안 저장소 구현과 독립적입니다.

`./mcp`의 `McpManager`는 주입받은 `McpSettingsStorage`로 설정을 저장하고 연결 수명을 관리합니다. 웹은 `createBrowserMcpSettingsStorage`로 localStorage를 선택합니다. 데스크톱은 `@keundal/plugin-chat-desktop/mcp`의 `createNativeMcpSettingsStorage`로 보안 저장소를 선택합니다. 플랫폼이 저장소와 stdio 허용 여부를 조립합니다.

`McpManager.probe(config, { signal })`는 저장하지 않은 설정을 검증한 뒤 임시 연결로 도구 목록을 조회합니다. 저장된 설정, 저장소, 진행 중인 응답의 연결에는 영향을 주지 않습니다. Streamable HTTP만 확인하며 stdio 설정은 연결하기 전에 거부합니다.

`./skills`의 `SkillManager`는 스킬 설정 저장과 파일 로딩을 담당합니다. 스키마와 타입은 `@keundal/chat/skills`에서 가져옵니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
