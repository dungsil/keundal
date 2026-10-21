# 패키지 경계 검토

PR #177의 플랫폼 분리를 바탕으로 계약, 재사용 알고리즘, 구현 플러그인과 앱 조립을 나눴습니다. 패키지 이름보다 서비스 교체 이유와 수명을 기준으로 경계를 정했습니다.

## 적용한 경계

| 계약                       | 구현 또는 정책                                           | 조립 책임                                      |
| -------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `agent`의 `AgentService`   | `agent-loop`, `plugin-agent-chat`, `plugin-agent-coding` | 앱이 구현을 선택합니다.                        |
| `tools`의 실행 도구 계약   | 파일·셸·채팅 도구와 MCP 클라이언트                       | 에이전트 조립 함수가 도구를 연결합니다.        |
| `context`의 준비·참조 계약 | `plugin-context`, `plugin-context-node`                  | 앱이 공급자와 순서를 선택합니다.               |
| `chat`의 화면·플랫폼 계약  | 로컬·원격 채팅 어댑터와 브라우저·데스크톱 구현           | 각 앱의 `app/platform.ts`가 구현을 선택합니다. |
| `mcp`의 설정·검증          | `plugin-mcp-client`의 SDK 연결                           | 앱이 설정 저장소와 연결을 조립합니다.          |
| `llm-settings`의 설정 모델 | 브라우저 저장소와 네이티브 보안 저장소                   | 플랫폼이 저장 방식을 선택합니다.               |

`agent-loop`는 플러그인이 아니라 대화·코딩 에이전트가 재사용하는 알고리즘입니다. 축약·도구 반복·병렬 실행 설정은 이 패키지가 소유합니다. `plugin-agent-coding`은 `plugin-agent-chat`을 상속하지 않고 공통 루프를 사용합니다. 이 선택은 [ADR 0001](adr/0001-agent-contract-and-loop.md)에 기록했습니다.

`chat`에는 도구 스키마와 화면에 필요한 결과 타입을 남겼습니다. 날씨·차트 실행은 `plugin-tool-chat`으로 옮겼습니다. `SkillManager`의 저장·로딩 구현은 브라우저 구현으로 옮기고 화면 계약과 분리했습니다.

## Cordis 수명

서비스 소비자는 계약에 의존하고 공급자 선택은 조립부가 담당합니다. LLM 교체는 실행 서비스의 재구성을 유발하지만, 저장소와 `session`을 폐기하지 않습니다. SQLite와 IndexedDB의 회귀 테스트는 교체 전후의 대화 revision과 완료 journal을 확인합니다.

이 분리는 AG-UI 이벤트, 저장소 형식과 설정 키를 바꾸지 않습니다. 성공 이벤트는 커밋 이후에 전달하고, 복구는 LLM을 다시 호출하지 않습니다. 취소와 플러그인 해제는 기존 공개 인터페이스 테스트로 검증합니다.

## import 이전

- 기존 `agent-contract`의 `AgentService`는 `@keundal/agent`에서 가져옵니다.
- 기존 `agent`의 `Agent`, `registerAgent`, `AgentConfig`는 `@keundal/agent-loop`에서 가져옵니다.
- 기존 `agent`의 기본 플러그인은 `@keundal/plugin-agent-chat`에서 가져옵니다.
- 기존 `coding-agent`는 `@keundal/plugin-agent-coding`으로 바꿉니다.
- `ExecutableTool`, `ToolProvider`, `ToolExecutionContext`는 `@keundal/tools`에서 가져옵니다.
- 컨텍스트 구현은 `plugin-context` 또는 `plugin-context-node`에서 가져옵니다. 순수 메시지·참조 도우미는 `context`에 남습니다.
- `McpClient`는 `@keundal/plugin-mcp-client`에서 가져옵니다. 브라우저 연결은 공개 하위 경로 `/browser`를 사용합니다.
- 공급자 설정은 `@keundal/llm-settings`로, 채팅 도구 실행은 `@keundal/plugin-tool-chat`으로 바꿉니다.

## 검사 범위와 남긴 선택

`pnpm check:boundaries`는 공통 UI와 계약 패키지의 구현 의존성을 거부합니다. `agent-loop`도 구현 플러그인을 직접 가져올 수 없습니다. 통합 테스트의 개발 의존성은 허용합니다.

Node.js 런타임의 환경 변수 해석과 기본 구성을 파일로 나눴습니다. 독립 소비자가 없으므로 MCP 도구 조립만을 위한 패키지는 추가하지 않았습니다. 기존 채팅 어댑터와 브라우저 공급자 패키지 이름도 유지했습니다. YAML 로더와 실행 중 패키지 설치는 이번 범위에 포함하지 않았습니다.

참고한 구조는 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)입니다. Harness의 수정된 Cordis를 그대로 복사하지 않고, 이 저장소의 Cordis 4 서비스 수명과 주입 계약을 유지했습니다.
