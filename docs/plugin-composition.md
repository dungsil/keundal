# 플랫폼별 플러그인 조립

web과 desktop은 공통 UI를 사용하며, LLM·저장소·에이전트·도구를 런타임 JSON 설정으로 선택합니다. 앱의 `app/platform.ts`는 실행 환경과 기본 플러그인 목록을 제공합니다. 공통 채팅 레이어는 `@keundal/ui-runtime`을 거쳐 `ChatPlatform` 계약으로 설정·대화·모델 목록·받아쓰기를 사용합니다. 화면 구성은 [UI 플러그인 문서](ui-plugins.md)를 따릅니다.

| 경계                                         | 담당 패키지 또는 경로                  |
| -------------------------------------------- | -------------------------------------- |
| 채팅 데이터와 플랫폼 계약                    | `@keundal/chat`                        |
| 화면 셸과 UI 플러그인 조립                   | `@keundal/chat-app`                    |
| 화면 기능과 공유 화면 상태                   | `@keundal/ui-*`, `@keundal/ui-runtime` |
| Cordis 서비스로 대화 실행                    | `@keundal/plugin-chat-local`           |
| HTTP 호스트 연결                             | `@keundal/chat-http`                   |
| sidecar·OS 보안 저장소·로컬 스킬 IPC         | `@keundal/plugin-chat-desktop`         |
| 브라우저 설정 저장과 MCP 연결 관리           | `@keundal/plugin-chat-browser`         |
| 브라우저 LLM 설정과 모델 목록 캐시           | `@keundal/plugin-llm-browser`          |
| 브라우저 LLM·MCP·받아쓰기의 기본 공급자 조립 | `@keundal/browser-composition`         |
| 공급자와 무관한 호스트와 HTTP 연결           | `@keundal/agent-host`                  |
| Node.js 환경 설정과 기본 플러그인 구성       | `@keundal/agent-runtime-node`          |
| 런타임 플러그인 설정과 Cordis 모듈 로딩      | `@keundal/plugin-runtime`              |

`@keundal/llm`, `@keundal/session`, `@keundal/generation`, `@keundal/skill`은 각 서비스 계약과 Cordis Context 확장을 소유합니다. `@keundal/agent`, `@keundal/tools`, `@keundal/context`, `@keundal/mcp`, `@keundal/shell`, `@keundal/transcription`, `@keundal/fs`, `@keundal/workspace`도 구현 플러그인에 의존하지 않습니다. `@keundal/core`는 AG-UI 프로토콜과 공통 실행·메시지만 제공하며 기능별 계약을 다시 내보내지 않습니다.

Git 작업공간은 `@keundal/workspace` 계약, `@keundal/plugin-workspace-git` 로컬 구현, `@keundal/plugin-tool-workspace` 에이전트 도구로 분리합니다. 기본 Node.js 구성은 대화별 Worktree와 코딩 에이전트를 조립하고, `@keundal/ui-workspace`가 프로젝트 선택·Diff 검토·원본 적용을 연결합니다. 원본 적용은 모델 도구로 제공하지 않으며 사용자가 검토한 변경만 적용합니다. 조립과 검토 경계는 [Git 작업공간 문서](../packages/plugin-workspace-git/README.md)와 [Node.js 호스트 문서](../packages/agent-runtime-node/README.md)를 참고합니다.

기본 실행 루프는 `@keundal/agent-loop`가 소유하고, 요약 축약은 `@keundal/compaction-summary`, 도구 반복은 `@keundal/tool-execution`, 지연 도구는 `@keundal/deferred-tools`, 실행 추적은 `@keundal/trace`를 조합합니다. 독립적인 에이전트는 `AgentService`를 구현하고, 기본 루프를 재사용할 때는 `agent-loop`의 `Agent`를 상속합니다. 계약과 구현의 전체 경계와 가져오기 경로 변경은 [ADR-0005](adr/0005-service-package-boundaries.md)를 참고합니다.

`@keundal/plugin-agent-chat`과 `@keundal/plugin-agent-coding`은 같은 루프를 재사용하는 별도 구현입니다. 코딩 구현은 채팅 구현에 의존하지 않습니다. `@keundal/plugin-context`는 환경에 독립적인 컨텍스트 공급자를, `@keundal/plugin-context-node`는 로컬 파일·에이전트 지침·tmux 공급자를 제공합니다. 스킬의 Markdown 형식 해석은 `@keundal/skill-markdown`이 담당합니다.

플러그인은 다른 플러그인의 구현을 가져오지 않습니다. 서비스 계약이나 공통 알고리즘을 사용하고, 구체적인 공급자는 앱·`browser-composition`·`agent-runtime-node`에서 선택해 주입합니다. `agent-loop`처럼 여러 구현이 재사용하는 실행 알고리즘은 유지합니다. UI 슬롯의 타입은 `@keundal/ui/app/contracts/*`에서 공유하고, 실제 슬롯의 선언과 해제는 화면을 소유한 플러그인이 담당합니다.

메모리 저장 어댑터의 계약은 `@keundal/memory`, 공통 검색·revision 처리는 `@keundal/memory-store`가 소유합니다. 메모리·IndexedDB·SQLite 저장소 플러그인과 `plugin-memory`는 이 공통 처리를 재사용하며 서로의 구현을 가져오지 않습니다. `plugin-memory`는 어댑터를 받아 서비스를 등록하는 진입점만 제공합니다.

기능 추가는 해당 플러그인과 조립 목록에서 처리합니다. `chat-app/app/ui-plugins.ts`는 목록만 소유하며 등록·해제 로직은 `ui-plugin-manager.ts`에 둡니다. Node.js의 MCP·Agent Plugins 수명은 `agent-integrations.ts`, 코딩 파일시스템 구성은 `coding-agent.ts`에서 관리합니다. 저장소 형식과 기존 플러그인 선택 식별자는 바꾸지 않습니다.

### 가져오기와 주입 변경

- `@keundal/plugin-chat-remote`는 `@keundal/chat-http`로 바꿉니다. `RemoteChatStore`의 계약과 HTTP 동작은 같습니다.
- 기본 `browserLLMPlugin`과 `loadModels`는 `@keundal/browser-composition/llm`에서 가져옵니다. `plugin-llm-browser`를 직접 사용할 때는 `providers`와 `ModelLoaders`를 주입합니다.
- `@keundal/plugin-transcription-browser`의 `openaiTranscription`은 `@keundal/browser-composition/transcription`으로 옮겼습니다.
- `McpManager`에는 `McpConnector`를, `BrowserMcpOAuth`의 세 번째 인자에는 계정 팩터리를 전달합니다. 웹 기본값은 `@keundal/browser-composition/mcp`의 `browserMcpConnector`와 `createBrowserMcpAccount`입니다. `BrowserAgentPluginManager`의 두 번째 인자도 같은 연결자를 받습니다.
- `loadAgentPlugin(config, options)`에서 MCP를 사용하면 `options.connectMcp`를 전달합니다. Node.js 기본 조립은 `McpClient.connect`를 주입합니다.
- `@keundal/ui-{chat,composer,layout,settings}/slots`는 각각 `@keundal/ui/app/contracts/{chat,composer,layout,settings}.ts`로 바꿉니다. 타입만 사용하는 플러그인은 슬롯 소유자 패키지에 의존하지 않습니다.

## 구현 교체

- web은 `/keundal.plugins.json`을 연결할 때 읽습니다. `NUXT_PUBLIC_PLUGIN_CONFIG`로 다른 설정 URL을 지정합니다. `agentEndpoint`가 있으면 브라우저 설정 대신 HTTP 호스트 구성을 사용합니다.
- desktop은 `KEUNDAL_PLUGIN_CONFIG`로 설정 파일을 선택합니다. 환경 변수가 없으면 앱 데이터 디렉터리의 `keundal.plugins.json`을 우선합니다. 공통 UI에는 Tauri 의존성이 없습니다.
- MCP 설정과 연결은 앱이 `ChatPlatform.mcp`로 제공합니다. Node.js의 MCP와 Agent Plugins 구성은 `@keundal/agent-runtime-node`가 담당합니다.
- MCP 설정과 검증은 `@keundal/mcp`, SDK 연결은 `@keundal/plugin-mcp-client`가 담당합니다. 연결 관리자는 설정 저장소를 주입받으며, 브라우저와 네이티브 저장소 선택은 앱이 담당합니다.
- `@keundal/chat`은 화면 계약과 데이터 변환을 제공합니다. 공급자 설정 정책은 `@keundal/llm-settings`, 날씨 실행은 `@keundal/plugin-tool-weather`, 차트 실행은 `@keundal/plugin-tool-chart`, 스킬 저장·로딩은 플랫폼 구현에 둡니다. 날씨·차트 스키마와 결과 타입은 `@keundal/chat/tools/*`에 유지하고, 결과 카드는 `@keundal/ui-weather`와 `@keundal/ui-chart`가 각각 등록합니다.
- 두 앱 모두 `loadModels`와 `transcription`을 교체할 수 있습니다. 기본 설정 화면은 기존 OpenAI·Anthropic·Gemini API 설정 형식을 유지합니다.
- `createAgentHost()`에는 `setup(ctx)`와 `mountAgent(ctx, config)`를 전달합니다. 호스트 내부에는 LLM 공급자 목록, SQLite 등록, 기본 에이전트 선택이 없습니다.
- 호스트의 `AgentMountConfig`는 모델과 출력 예산만 전달합니다. 도구와 반복 횟수는 각 조립 함수에서 구현 설정으로 연결합니다.
- Node.js 앱은 `createAgentRuntime(env, { compose })`를 호출합니다. 기본값을 사용할 때도 `createNodeComposition`을 명시합니다. 다른 구성을 넘기면 환경 변수와 HTTP 처리를 유지하면서 구현만 바꿀 수 있습니다. 환경 변수 형식 자체를 바꿀 때는 앱에서 `createAgentHost()`와 `createAgentApp()`을 직접 조립합니다.

플러그인은 전달받은 Cordis 컨텍스트에 등록해야 합니다. 호스트가 생성한 범위는 초기화 실패와 종료 시 하위 플러그인을 정리합니다. 모델별 에이전트는 격리된 범위에서 실행하며, 등록이 실패한 범위도 정리합니다. 앱 연결의 `dispose()`는 진행 중인 대화를 중단하고 소유한 자원을 해제해야 합니다.

저장소와 `session`의 수명은 LLM에 종속시키지 않습니다. LLM을 교체하면 `generation`과 에이전트만 다시 구성하며 기존 세션과 journal은 유지합니다. 플러그인 전체를 해제할 때는 진행 중인 생성을 먼저 정리한 뒤 소유한 저장소를 닫습니다.

`chatCapabilities.secureSettings`와 `chatCapabilities.localSkills`는 화면에 표시할 저장소 설명과 스킬 파일 설정을 정합니다. 구현 선택은 이 플래그가 아니라 앱의 조립 코드가 담당합니다. 저장소 키, IndexedDB 이름, SQLite 형식과 보안 저장소 이전 규칙은 유지합니다.

## 런타임 설정

다음 형식으로 서비스 플러그인, 에이전트, 도구 팩터리를 선택합니다. 기본 플러그인도 같은 로더를 사용합니다.

```json
{
  "plugins": [
    { "module": "./plugins/llm.mjs", "config": { "endpoint": "https://llm.example.com" } },
    { "module": "builtin:store" }
  ],
  "agent": { "module": "builtin:agent", "config": { "maxToolRounds": 4 } },
  "tools": [{ "module": "./plugins/tools.mjs", "export": "createTools", "config": { "project": "example" } }]
}
```

`plugins`는 배열 순서대로 Cordis 플러그인을 등록합니다. 기본 내보내기는 `default`이며, `export`로 다른 내보내기를 선택합니다. 플러그인은 사용하는 서비스의 `inject`를 선언하고, 자원 정리 함수를 전달받은 컨텍스트에 등록해야 합니다. 에이전트는 `ctx.agent`를 제공해야 합니다.

도구 팩터리는 `(config, execution)`을 받아 `ExecutableTool[]` 또는 해당 Promise를 반환합니다. 목록을 조회할 때마다 호출하며 취소 신호도 전달합니다. 실행의 모델·출력 예산·추론 설정은 매니페스트의 에이전트 설정보다 우선합니다. 도구는 `agent.config.tools`가 아니라 최상위 `tools`에 지정합니다.

### 브라우저

배포한 `/keundal.plugins.json`을 수정하면 앱을 다시 빌드하지 않아도 새 연결에 적용됩니다. 외부 모듈은 브라우저가 직접 실행할 수 있는 ESM 파일이어야 합니다. 상대 경로는 설정 응답 URL을 기준으로 해석합니다. 다른 origin의 설정과 모듈은 CORS를 허용해야 합니다. bare 패키지 이름과 Node.js 전용 모듈은 지원하지 않습니다.

`builtin:llm`은 기존 공급자 설정을 읽고, `builtin:store`는 IndexedDB를 사용합니다. `builtin:skills`, `builtin:agent`, `builtin:chart`, `builtin:weather`, `builtin:todo`도 제공합니다. 기본 매니페스트는 차트·날씨·TODO를 각각 등록하므로 필요한 도구만 남길 수 있습니다. 기존 `builtin:chat-tools`는 차트와 날씨를 함께 제공하는 호환 별칭으로 유지합니다. `tools: []`는 기본 차트·날씨·TODO 도구를 제외합니다. 사용자가 별도로 활성화한 MCP와 Agent Plugins 도구는 유지합니다.

### Node.js와 desktop

`KEUNDAL_PLUGIN_CONFIG`가 없으면 현재 디렉터리의 `keundal.plugins.json`을 찾습니다. desktop은 이 탐색 전에 앱 데이터 디렉터리의 설정을 선택합니다. 파일이 없으면 기존 기본 구성을 사용합니다. 명시한 파일을 읽지 못하거나 설정·모듈이 잘못됐으면 시작을 거부합니다.

외부 모듈은 설정 파일 기준 상대 경로, 절대 경로, `file:` URL 또는 설치된 패키지 이름으로 지정합니다. 패키지도 설정 파일 디렉터리를 기준으로 찾으며 ESM `exports.import` 조건을 사용합니다. 배포 매니페스트가 참조하는 패키지는 별도로 설치합니다. `builtin:store`는 SQLite를 사용합니다.

날씨·차트·TODO 도구는 `tools`에 `{ "module": "@keundal/plugin-tool-weather" }`, `{ "module": "@keundal/plugin-tool-chart" }`, `{ "module": "@keundal/plugin-tool-todo" }`로 각각 선택합니다. 각 패키지의 기본 내보내기는 도구 팩터리입니다. desktop의 기본 구성은 세 팩터리를 함께 사용하며, 매니페스트에 `tools`를 지정하면 이 기본 목록을 대체합니다. 기존 `@keundal/plugin-tool-chat`을 직접 가져오던 조립 코드는 필요한 팩터리인 `createWeatherTools()`와 `createChartTools()`로 바꿉니다.

`todo_write`는 전체 작업 목록과 항목별 진행 상태를 도구 결과로 기록하며 별도 저장소는 사용하지 않습니다. 웹과 desktop의 선택 기능 목록에서 독립적으로 관리하고 Node.js 코딩 에이전트에도 같은 선택을 적용합니다. 입력 형식과 기록 범위는 [TODO 도구 문서](../packages/plugin-tool-todo/README.md)를 참고합니다.

설정을 변경한 뒤 웹 호스트나 desktop sidecar를 다시 시작해야 합니다. 기존 저장소와 같은 경로를 선택하면 대화 기록을 유지합니다. 저장소를 바꿔도 데이터를 자동으로 이전하지 않습니다.

### UI에서 선택 기능 관리

**설정 → 큰달 플러그인**(`/settings/runtime-plugins`)은 앱에 함께 패키징한 실행 목록과 UI 목록을 함께 표시합니다. 필수 서비스인 LLM·저장소와 선택을 복구하는 관리 셸인 `@keundal/ui-layout`, `@keundal/ui-settings`, `@keundal/ui-agent-plugins`는 잠긴 항목입니다. 나머지 번들 실행·UI 플러그인은 각각 끄고 켤 수 있습니다. 채팅 에이전트를 끄면 새 응답을 막되 기존 세션과 기능 목록·관리 화면은 유지합니다. desktop에서는 외부 큰달 플러그인도 설치하고 관리합니다. web은 번들된 모듈만 관리합니다. **에이전트 플러그인**(영문 **Agent plugins**)의 폴더 가져오기는 스킬·MCP 묶음을 관리하는 별도 기능입니다.

- **화면**: 셸의 UI 관리자가 저장한 선택과 `requires`에 따라 UI의 Cordis 등록 범위를 해제하거나 다시 등록합니다. 의존 대상이 꺼지면 해당 UI와 탐색 항목을 일시 해제하지만 저장한 활성화 선택은 유지합니다. 의존 대상을 다시 켜면 활성화해 둔 UI만 복원하며, 직접 끈 UI는 꺼진 상태를 유지합니다. Nuxt 레이어는 모두 빌드에 유지합니다.
- **web 로컬 실행**: 스킬을 끄면 해당 서비스의 효과를 해제하고, 도구와 MCP를 끄면 이후 실행 목록에서 제외합니다. 실행 선택은 기존 `BrowserRuntimePluginManager`가 `keundal:bundled-plugins` localStorage에 저장합니다. UI 선택은 브라우저 localStorage의 `keundal:ui-plugin-selections`에 별도로 저장합니다.
- **desktop 실행**: 번들 실행 선택과 외부 설치 목록을 기존 네이티브 저장소인 앱 데이터 디렉터리에 유지합니다. 실행 선택을 바꾸면 sidecar를 다시 시작하며 실패하면 이전 선택으로 복구합니다. UI 선택은 브라우저 localStorage의 `keundal:ui-plugin-selections`에 저장하고 서버 구성을 바꾸지 않습니다. npm을 앱에 포함하므로 시스템에 Node.js나 npm을 따로 설치할 필요가 없습니다.
- **원격 서버 연결**: `platform.runtimePlugins`가 없어도 셸의 `runtime.pluginManager`는 로컬 UI 목록과 선택을 제공합니다. 이 경우 서버의 실행 목록은 관리하지 않습니다. 서버의 실행 기능을 바꾸거나 서버에 패키지를 설치하는 API는 제공하지 않습니다.

각 항목의 `requires`는 의존 대상을 나타냅니다. 관리 화면은 **의존 대상**(Requires)과 이 항목을 참조하는 **사용하는 플러그인**(Used by)을 함께 표시합니다. UI는 공통으로 `@keundal/ui-layout`에 의존하며, 기능별 관계는 다음과 같습니다.

| UI 항목                                  | 의존하는 실행 기능           |
| ---------------------------------------- | ---------------------------- |
| `@keundal/ui-skill`                      | `@keundal/plugin-skill`      |
| `@keundal/ui-mcp`                        | `@keundal/plugin-mcp-client` |
| `@keundal/ui-settings-llm/prompt-plugin` | `@keundal/prompt`            |
| `@keundal/ui-subagents`                  | `@keundal/subagent`          |

`@keundal/prompt`와 `@keundal/subagent`는 공통 에이전트 루프에 내장된 프롬프트 프리셋·서브에이전트 기능의 선택 항목입니다. 새 구현 플러그인 패키지를 등록하는 것은 아닙니다. 프롬프트 UI는 `@keundal/ui-settings-llm/prompt-plugin`으로 따로 내보내므로 LLM 공급자 설정 UI인 `@keundal/ui-settings-llm`과 독립적으로 선택합니다.

`@keundal/ui-tool`은 `delegate_task`, `skill`, `web_search`, `google_search` 결과를, `@keundal/ui-chart`와 `@keundal/ui-weather`는 차트와 날씨 결과를 표시합니다. 세 결과 UI도 각각 끄고 켤 수 있지만 실행 도구에는 의존하지 않습니다. `@keundal/plugin-tool-chart`와 `@keundal/plugin-tool-weather`를 각각 끄면 이후 실행 목록에서 해당 도구만 제외하며, 사용자가 UI를 따로 끄지 않으면 기존 결과를 계속 표시합니다. 이전 통합 도구의 저장된 선택은 두 도구에 반영하되, 이미 저장한 개별 선택이 있으면 이를 우선합니다. desktop은 이전 통합 도구·개별 도구 선택 형식도 새 목록으로 이전하며, 새 선택 항목은 기본값을 사용합니다.

서버 렌더링과 최초 하이드레이션에서는 기본 UI를 등록합니다. 앱이 마운트된 뒤 저장한 UI 선택과 실행 기능의 의존 상태를 동기화하므로, 저장된 비활성화 상태가 있어도 하이드레이션에는 같은 구성을 사용합니다. 이전 `keundal-ui-plugins` 쿠키는 읽거나 선택에 반영하지 않습니다.

변경 전에는 진행 중인 응답을 중단합니다. 기본 선택은 기존 번들 구성을 유지하며, 비활성화해도 사용자 설정과 IndexedDB·SQLite 대화 기록은 지우지 않습니다. 이전의 외부 모듈 설치 목록은 자동으로 불러오지 않으며 다운로드했던 파일도 자동 삭제하지 않습니다. 배포 매니페스트는 운영자가 관리하는 별도 설정으로 유지합니다.

새 번들 선택 기능을 제공하려면 모노레포 패키지를 앱의 정적 기능 목록에 추가하고 함께 빌드합니다. UI는 `@keundal/chat-app`의 UI 목록에 추가하고 해당 기능이 있어야 동작한다면 `requires`도 선언합니다. 기존 기록을 표시하는 결과 UI에는 실행 도구 의존성을 두지 않습니다. 목록의 의존 관계와 별개로 플러그인은 `inject`로 서비스 의존성을 선언하고 전달받은 컨텍스트에 효과를 등록해야 비활성화 시 올바르게 해제됩니다.

### desktop 외부 큰달 플러그인

설치 출처를 선택하고 패키지 이름이나 절대 경로를 입력한 뒤 신뢰 확인란을 선택합니다. 외부 코드는 호스트 권한으로 실행됩니다. 설치 직후에는 비활성이며, 목록의 스위치로 켤 때 `default` 내보내기를 Cordis 플러그인으로 등록합니다. 표시 정보는 코드를 실행하지 않고 `package.json`에서 읽습니다. 별도의 Vue UI를 동적으로 빌드하거나 등록하지 않습니다.

| 출처      | 입력 예시                                          | 처리                                                               |
| --------- | -------------------------------------------------- | ------------------------------------------------------------------ |
| npm       | `@example/keundal-plugin@1.2.3`                    | npm 레지스트리에서 의존성과 함께 설치                              |
| JSR       | `@example/keundal-plugin@1.2.3`                    | `npm.jsr.io`의 `@jsr/example__keundal-plugin` 패키지로 설치        |
| 로컬 ZIP  | `/home/me/plugin.zip` 또는 `C:\plugins\plugin.zip` | 최상위 또는 단일 하위 폴더에 `package.json`이 있는 ZIP을 풀고 설치 |
| 로컬 경로 | `/home/me/plugin` 또는 `/home/me/plugin.mjs`       | 패키지 폴더는 복사하여 설치하고 JavaScript 파일은 원본 경로를 참조 |

패키지는 Node.js에서 실행할 수 있는 JavaScript 진입점을 제공해야 합니다. TypeScript 소스는 미리 빌드합니다. npm의 설치·빌드 스크립트는 실행하지 않으므로 설치 스크립트가 필요한 네이티브 의존성은 지원하지 않습니다. 로컬 폴더의 변경을 적용하려면 삭제 후 다시 설치합니다. 파일 경로는 sidecar를 다시 시작할 때 다시 읽습니다. ZIP은 압축 파일 50 MiB, 압축 해제 합계 200 MiB, 항목 10,000개까지 허용하고 경로 탈출을 거부합니다.

활성화가 실패하면 오류를 표시하고 이전 선택과 호스트를 복구합니다. 앱 시작 시 외부 플러그인 하나가 실패해도 관리 화면은 유지합니다. 삭제는 성공적으로 호스트를 교체한 뒤 관리하는 설치 파일만 지우며, 원본 ZIP·폴더·파일과 SQLite 대화 기록은 지우지 않습니다. 필수 서비스 교체는 기존 배포 매니페스트를 사용하며, 외부 설치가 매니페스트를 덮어쓰지 않습니다.

### Deferred Tools

`agent.config.deferredTools`에 `{}`를 지정하면 기본 web과 Node.js 조립이 MCP 도구를 검색 대상으로 분리합니다. Agent Plugins가 제공하는 MCP 도구도 같은 대상에 포함합니다. 매니페스트 도구 팩터리와 직접 전달한 기본 도구는 항상 노출합니다.

```json
{
  "plugins": [{ "module": "builtin:llm" }, { "module": "builtin:store" }],
  "agent": {
    "module": "builtin:agent",
    "config": {
      "deferredTools": {
        "maxSearchResults": 8,
        "maxActiveTools": 16,
        "maxSchemaBytes": 16384,
        "maxTotalSchemaBytes": 65536
      }
    }
  }
}
```

설정을 생략하면 기존처럼 MCP Schema를 직접 노출합니다. 별도 조립은 `loadRuntimePlugins()`의 `deferredToolProvider`에 현재 권한으로 조회하는 도구 공급자를 전달합니다. 검색과 실행은 기존 MCP 허용 목록과 리소스 권한을 유지합니다.

### 모델 가격표

`agent.config.pricing`에 모델 ID별 100만 토큰당 가격을 지정하면, 공급자가 비용을 주지 않는 모델 호출의 비용을 실행 추적에 추정값으로 기록합니다. 가격표는 모델 선택과 같은 배포 설정이므로 매니페스트에 두며, 설정 화면의 사용자 데이터에는 저장하지 않습니다. web과 Node.js 호스트, desktop이 같은 형식을 사용합니다. 형식과 계산 규칙은 [실행 관측 문서](execution-trace.md#모델-가격표)를 참고합니다.

### 신뢰 경계

설정은 실행할 코드를 선택하므로 신뢰할 수 있는 파일과 URL만 사용해야 합니다. 플러그인은 샌드박스에서 실행하지 않습니다. 브라우저 플러그인은 앱 origin의 데이터에, Node.js 플러그인은 호스트 프로세스의 권한과 환경 변수에 접근할 수 있습니다. 브라우저에 전달하는 공개 설정에는 비밀 값을 넣지 않습니다.

## 경계 검증

`pnpm check:boundaries`는 앱 간 의존성과 함께 공통 UI·계약 패키지의 구현 의존성을 검사합니다. 통합 테스트의 개발 의존성은 허용하지만, 실행 의존성과 `src`, `app`, `shared`의 구현 직접 참조는 거부합니다. 플러그인끼리의 구현 참조와 UI 기능끼리의 참조도 거부합니다. 타입 가져오기, 동적 가져오기, 재노출, 상대 경로, 의존성 별칭과 Nuxt·TypeScript 설정도 검사합니다. 선택에 쓰는 모듈 이름 문자열은 구현 참조로 보지 않습니다.
