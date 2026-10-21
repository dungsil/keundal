# 공용 채팅 레이어

`@keundal/chat-app`은 web과 desktop이 공유하는 화면과 Vue 상태를 제공하는 Nuxt 레이어입니다. `@keundal/ui`를 상속하며 대화·설정·모델 목록·스킬 화면과 공용 에셋을 관리합니다.

앱은 `extends: ['@keundal/chat-app']`으로 레이어를 사용하고, 먼저 실행되는 `chat-platform` Nuxt 플러그인에서 `@keundal/chat/platform`의 `ChatPlatform`을 제공합니다. 공통 레이어는 이 계약을 사용하며 IndexedDB, LLM SDK, Tauri, sidecar 구현을 직접 가져오지 않습니다.

`runtimeConfig.public.chatCapabilities`는 보안 저장소 설명과 로컬 스킬 설정의 표시 여부를 정합니다. 구현과 실행 수명은 각 앱의 `app/platform.ts`에서 관리합니다. 자세한 경계와 교체 방법은 [플러그인 조립 문서](../../docs/plugin-composition.md)를 참고합니다.

## 검증

```sh
pnpm --filter @keundal/chat-app test
pnpm --filter @keundal/chat-app typecheck
pnpm --filter @keundal/chat-app lint
pnpm check:boundaries
```

공급자 연결과 저장소 회귀 테스트는 `tests/`에 있습니다. 앱별 조립 테스트는 각 앱의 `tests/platform.test.ts`에서 실행합니다.

## MCP 서버

**Settings → MCP**에서 서버를 추가·수정·삭제합니다. 서버 이름, 연결 주소 또는 실행 명령, 인증 정보와 권한을 입력합니다. 허용할 도구 이름과 리소스 URI는 한 줄에 하나씩 입력합니다. `*`는 전체 허용이며, 빈 목록은 접근을 차단합니다. 인자에는 JSON 배열을, HTTP 헤더와 환경 변수에는 JSON 객체를 사용합니다.

- 웹은 Streamable HTTP를 지원하며 브라우저에서 서버에 직접 연결합니다. 서버가 앱 origin의 CORS 요청과 MCP 헤더를 허용해야 합니다. HTTPS 앱에서는 HTTPS 서버를 사용합니다. 인증 정보를 포함한 설정은 브라우저 localStorage에 저장합니다.
- 데스크톱은 Streamable HTTP와 stdio를 지원합니다. 로컬 호스트가 서버에 연결하며, stdio 명령은 셸을 거치지 않고 실행합니다. 실행할 명령은 설치되어 있어야 합니다. 설정은 OS 보안 저장소의 `com.keundal.desktop` 서비스, `mcp-settings` 항목에 저장하며 브라우저 저장소로 대체하지 않습니다. 신뢰하는 서버만 등록합니다.
- 원격 에이전트를 사용하는 웹에서는 호스트 관리자가 `KEUNDAL_MCP_SERVERS`를 설정합니다. 브라우저 설정으로 원격 호스트의 실행 명령을 변경하지 않습니다.

저장하면 진행 중인 응답을 중단하며 데스크톱은 로컬 호스트를 다시 시작합니다. 서버 연결과 도구 조회는 다음 응답을 시작할 때 수행하므로, 설정 저장 성공은 서버 연결 성공을 뜻하지 않습니다. 연결이나 도구 조회가 실패하면 해당 응답에 오류를 표시합니다. 설정을 수정하거나 다시 요청하면 연결을 다시 시도할 수 있습니다. 제목 생성에는 MCP 도구를 사용하지 않습니다.

응답을 시작할 때 서버의 도구 목록을 다시 조회하고, 허용한 도구와 리소스만 에이전트에 제공합니다. 취소는 MCP 요청에 전달하며, 호스트 종료나 설정 교체 시 연결을 정리합니다. 데스크톱은 종료 제어 파이프를 닫아 호스트가 MCP 자원을 정리할 시간을 주고, 5초 안에 종료되지 않으면 호스트를 강제로 종료합니다. OAuth 로그인, 레거시 SSE, MCP prompts는 지원하지 않습니다.
