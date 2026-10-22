# 플랫폼별 플러그인 조립

web과 desktop은 공통 UI를 사용하며, LLM·저장소·에이전트·도구를 런타임 JSON 설정으로 선택합니다. 앱의 `app/platform.ts`는 실행 환경과 기본 플러그인 목록을 제공합니다. 공통 채팅 레이어는 `ChatPlatform` 계약으로 설정·대화·모델 목록·받아쓰기를 사용합니다.

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
| 런타임 플러그인 설정과 Cordis 모듈 로딩     | `@keundal/plugin-runtime`               |

`@keundal/agent`, `@keundal/tools`, `@keundal/context`, `@keundal/mcp`는 구현을 가져오지 않는 계약입니다. `@keundal/shell`, `@keundal/transcription`, `@keundal/fs`도 서비스 계약만 제공합니다. 기본 실행 루프와 축약·도구 정책은 `@keundal/agent-loop`가 소유합니다. 독립적인 에이전트는 `AgentService`를 구현하고, 기본 루프를 재사용할 때는 `agent-loop`의 `Agent`를 상속합니다.

`@keundal/plugin-agent-chat`과 `@keundal/plugin-agent-coding`은 같은 루프를 재사용하는 별도 구현입니다. 코딩 구현은 채팅 구현에 의존하지 않습니다. `@keundal/plugin-context`는 환경에 독립적인 컨텍스트 공급자를, `@keundal/plugin-context-node`는 로컬 파일·에이전트 지침·tmux 공급자를 제공합니다. 스킬의 Markdown 형식 해석은 `@keundal/skill-markdown`이 담당합니다.

## 구현 교체

- web은 `/keundal.plugins.json`을 연결할 때 읽습니다. `NUXT_PUBLIC_PLUGIN_CONFIG`로 다른 설정 URL을 지정합니다. `agentEndpoint`가 있으면 브라우저 설정 대신 HTTP 호스트 구성을 사용합니다.
- desktop은 `KEUNDAL_PLUGIN_CONFIG`로 설정 파일을 선택합니다. 환경 변수가 없으면 앱 데이터 디렉터리의 `keundal.plugins.json`을 우선합니다. 공통 UI에는 Tauri 의존성이 없습니다.
- MCP 설정과 연결은 앱이 `ChatPlatform.mcp`로 제공합니다. Node.js의 MCP와 Agent Plugins 구성은 `@keundal/agent-runtime-node`가 담당합니다.
- MCP 설정과 검증은 `@keundal/mcp`, SDK 연결은 `@keundal/plugin-mcp-client`가 담당합니다. 연결 관리자는 설정 저장소를 주입받으며, 브라우저와 네이티브 저장소 선택은 앱이 담당합니다.
- `@keundal/chat`은 화면 계약과 데이터 변환을 제공합니다. 공급자 설정 정책은 `@keundal/llm-settings`, 날씨·차트 실행은 `@keundal/plugin-tool-chat`, 스킬 저장·로딩은 플랫폼 구현에 둡니다.
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

`builtin:llm`은 기존 공급자 설정을 읽고, `builtin:store`는 IndexedDB를 사용합니다. `builtin:skills`, `builtin:agent`, `builtin:chat-tools`도 제공합니다. `tools: []`는 기본 날씨·차트 도구를 제외합니다. 사용자가 별도로 활성화한 MCP와 Agent Plugins 도구는 유지합니다.

### Node.js와 desktop

`KEUNDAL_PLUGIN_CONFIG`가 없으면 현재 디렉터리의 `keundal.plugins.json`을 찾습니다. desktop은 이 탐색 전에 앱 데이터 디렉터리의 설정을 선택합니다. 파일이 없으면 기존 기본 구성을 사용합니다. 명시한 파일을 읽지 못하거나 설정·모듈이 잘못됐으면 시작을 거부합니다.

외부 모듈은 설정 파일 기준 상대 경로, 절대 경로, `file:` URL 또는 설치된 패키지 이름으로 지정합니다. 패키지도 설정 파일 디렉터리를 기준으로 찾으며 ESM `exports.import` 조건을 사용합니다. 외부 패키지는 별도로 설치해야 합니다. 앱은 실행 중 패키지를 설치하지 않습니다. `builtin:store`는 SQLite를 사용합니다.

설정을 변경한 뒤 웹 호스트나 desktop sidecar를 다시 시작해야 합니다. 기존 저장소와 같은 경로를 선택하면 대화 기록을 유지합니다. 저장소를 바꿔도 데이터를 자동으로 이전하지 않습니다.

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

`pnpm check:boundaries`는 앱 간 의존성과 함께 공통 UI·계약 패키지의 구현 의존성을 검사합니다. 통합 테스트의 개발 의존성은 허용하지만, 실행 의존성과 `src`, `app`, `shared`의 구현 직접 참조는 거부합니다.
