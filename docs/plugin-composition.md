# 플랫폼별 플러그인 조립

web과 desktop은 공통 UI를 사용하면서 각 앱의 `app/platform.ts`에서 서로 다른 구현을 선택합니다. 앱의 `chat-platform.client.ts`가 이 구성을 먼저 제공하고, 공통 채팅 레이어가 `ChatPlatform` 계약으로 설정·대화·모델 목록·받아쓰기를 사용합니다.

| 경계                                        | 담당 패키지 또는 경로                   |
| ------------------------------------------- | --------------------------------------- |
| 채팅 데이터와 플랫폼 계약                   | `@keundal/chat`                         |
| 화면과 Vue 상태                             | `@keundal/chat-app`                     |
| Cordis 서비스로 대화 실행                   | `@keundal/plugin-chat-local`            |
| HTTP 호스트 연결                            | `@keundal/plugin-chat-remote`           |
| sidecar·OS 보안 저장소·로컬 스킬 IPC        | `@keundal/plugin-chat-desktop`          |
| 브라우저 설정 저장과 MCP 연결 관리          | `@keundal/plugin-chat-browser`          |
| 브라우저 LLM과 모델 목록의 기본 공급자 구성 | `@keundal/plugin-llm-browser`           |
| 브라우저 받아쓰기의 기본 공급자 구성        | `@keundal/plugin-transcription-browser` |
| 공급자와 무관한 호스트와 HTTP 연결          | `@keundal/agent-host`                   |
| Node.js 환경 설정과 기본 플러그인 구성      | `@keundal/agent-runtime-node`           |

`@keundal/agent-contract`, `@keundal/shell`, `@keundal/transcription`, `@keundal/fs`는 구현을 가져오지 않는 서비스 계약입니다. 기본 실행 루프는 `@keundal/agent`가 제공합니다. 독립적인 에이전트는 `AgentService`를 구현하며, 기본 루프를 재사용할 때는 기존 `Agent`를 상속할 수 있습니다. 스킬의 Markdown 형식 해석은 파일시스템 구현과 분리한 `@keundal/skill-markdown`이 담당합니다.

## 구현 교체

- web의 `apps/web/app/platform.ts`에서 IndexedDB 플러그인, LLM 플러그인, `mountAgent`와 도구를 선택합니다. `agentEndpoint`를 설정하면 HTTP 연결 구현을 사용합니다.
- desktop의 `apps/desktop/app/platform.ts`에서 네이티브 설정 저장소, 스킬 파일 공급자, sidecar 연결을 선택합니다. 공통 UI에는 Tauri 의존성이 없습니다.
- MCP 설정과 연결은 앱이 `ChatPlatform.mcp`로 제공합니다. Node.js의 MCP와 Agent Plugins 구성은 `@keundal/agent-runtime-node`가 담당합니다.
- 두 앱 모두 `loadModels`와 `transcription`을 교체할 수 있습니다. 기본 설정 화면은 기존 OpenAI·Anthropic·Gemini API 설정 형식을 유지합니다.
- `createAgentHost()`에는 `setup(ctx)`와 `mountAgent(ctx, config)`를 전달합니다. 호스트 내부에는 LLM 공급자 목록, SQLite 등록, 기본 에이전트 선택이 없습니다.
- Node.js 앱은 `createAgentRuntime(env, { compose })`를 호출합니다. 기본값을 사용할 때도 `createNodeComposition`을 명시합니다. 다른 구성을 넘기면 환경 변수와 HTTP 처리를 유지하면서 구현만 바꿀 수 있습니다. 환경 변수 형식 자체를 바꿀 때는 앱에서 `createAgentHost()`와 `createAgentApp()`을 직접 조립합니다.

플러그인은 전달받은 Cordis 컨텍스트에 등록해야 합니다. 호스트가 생성한 범위는 초기화 실패와 종료 시 하위 플러그인을 정리합니다. 모델별 에이전트는 격리된 범위에서 실행하며, 등록이 실패한 범위도 정리합니다. 앱 연결의 `dispose()`는 진행 중인 대화를 중단하고 소유한 자원을 해제해야 합니다.

`chatCapabilities.secureSettings`와 `chatCapabilities.localSkills`는 화면에 표시할 저장소 설명과 스킬 파일 설정을 정합니다. 구현 선택은 이 플래그가 아니라 앱의 조립 코드가 담당합니다. 저장소 키, IndexedDB 이름, SQLite 형식과 보안 저장소 이전 규칙은 유지합니다.

## 경계 검증

`pnpm check:boundaries`는 앱 간 의존성과 함께 공통 UI·계약 패키지의 구현 의존성을 검사합니다. 통합 테스트의 개발 의존성은 허용하지만, 실행 의존성과 `src`, `app`, `shared`의 구현 직접 참조는 거부합니다.

## 참고

[DeepSeek Harness의 패키지 구성](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/README.md)과 [프로필별 조립](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/composition.md)을 참고했습니다. 서비스 계약, 구현 공급자, 앱별 조립을 나누는 원칙을 적용했습니다. 현재 저장소에서는 타입이 검사되는 TypeScript 조립을 사용하며 YAML 로더나 실행 중 패키지 설치 기능은 추가하지 않았습니다.
