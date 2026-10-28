# @keundal/plugin-chat-desktop

sidecar 모델 전환, OS 보안 저장소와 기존 평문 설정의 이전, 로컬 스킬 파일 IPC를 제공합니다. `NativeInvoke`를 주입받으므로 Tauri API의 가져오기는 앱에서 담당합니다.

`./mcp`의 `createNativeMcpOAuth()`는 인증된 sidecar 제어 경로로 계정 연결·상태 조회·해제와 HTTP 연결 확인을 요청합니다. UI에는 토큰 대신 상태만 반환합니다. 기본 desktop 앱은 시스템 브라우저의 loopback 콜백을 처리하고, 자격 증명과 회전된 refresh token을 익명 pipe를 통해 Rust의 OS 보안 저장소에 기록합니다. localStorage·환경 변수·MCP 서버 설정에는 OAuth 자격 증명을 넣지 않습니다. 계정 변경 후에는 기존 호스트와 도구 연결을 교체합니다.

콜백 포트는 보안 저장소에 보존하며 로그인 중에만 리스너를 엽니다. 다른 프로세스가 해당 포트를 점유하면 로그인에 실패하며 임의 포트로 바꾸지 않습니다. 한 OS 사용자에서 앱 인스턴스 하나를 실행하는 구성을 전제로 합니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
