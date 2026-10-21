# @keundal/plugin-chat-browser

브라우저 localStorage에 LLM 설정을 저장하고 다른 탭의 변경을 구독합니다. OS 보안 저장소 구현과 독립적입니다.

`./mcp`는 MCP 설정과 연결 수명을 관리합니다. 웹은 localStorage와 Streamable HTTP를 사용하고, 데스크톱은 앱에서 주입한 IPC로 보안 저장소를 사용합니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
