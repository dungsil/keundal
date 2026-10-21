# @keundal/agent-host

Keundal의 `llm`, `session`, `generation`, `agent` 서비스를 Node.js에서 조립합니다.
HTTP 전송과 프로세스 수명은 호출자가 관리합니다.

```ts
import { createAgentHost } from '@keundal/agent-host'

const host = await createAgentHost({
  provider: 'openai',
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4.1-mini',
  models: { 'gpt-4.1-mini': { contextWindow: 1_047_576, maxOutputTokens: 4_096 } },
  sqlitePath: 'keundal.sqlite'
})

// host.services를 웹 서버나 데스크톱의 실행 계층에 연결합니다.
```

`host.services`는 HTTP 계층이 사용하는 `run`, `session`, `generation`, `models`, `title`을 제공합니다.
`host.dispose()`는 모델별 에이전트와 Cordis 컨텍스트를 정리합니다.

- [웹 앱](../../apps/web/README.md#웹-서버의-에이전트-모드)은 Nitro API에서 이 호스트를 직접 사용합니다.
- [데스크톱 앱](../../apps/desktop/README.md#로컬-호스트)은 자체 sidecar 진입점에서 이 호스트를 직접 사용합니다.
- 모델은 `models`에 등록한 ID만 사용할 수 있습니다.
- 저장소는 SQLite 파일 하나를 사용합니다.
- API 키가 없는 사용자 지정 엔드포인트는 `apiKey: ''`와 `baseURL` 또는 `headers`로 구성합니다.

## HTTP 연결과 환경 설정

`@keundal/agent-host/http`는 `createAgentApp(services, { token })`으로 인증·본문 크기 제한·AG-UI SSE·대화 및 실행 API를 제공하는 Node.js 요청 리스너를 만듭니다. 웹과 데스크톱은 같은 리스너를 사용하고 HTTP 서버의 생성과 종료는 각 앱이 담당합니다.

`@keundal/agent-host/runtime`의 `createAgentRuntime(env?)`는 `KEUNDAL_MODEL`, 공급자 API 키, `KEUNDAL_API_TOKEN`과 SQLite 설정을 읽어 호스트와 요청 리스너를 함께 반환합니다. `runtime.dispose()`로 자원을 정리합니다. SQLite 경로의 기본값은 `.data/keundal.sqlite`입니다. 환경 설정은 [웹 앱 문서](../../apps/web/README.md#웹-서버의-에이전트-모드)를 참고합니다.

API 키 없이 구성할 때는 `KEUNDAL_PROVIDER`를 명시합니다. HTTP 연결이 종료되면 실행과 제목 생성에 취소 신호를 전달합니다.

## MCP 연결

`createAgentHost()`의 `mcpServers` 옵션에 `@keundal/mcp`의 서버 설정 배열을 전달합니다. 환경 설정을 사용하는 웹 서버와 데스크톱 sidecar에서는 같은 배열을 JSON으로 직렬화한 `KEUNDAL_MCP_SERVERS`를 사용합니다. 설정을 생략하면 MCP에 연결하지 않습니다.

```json
[
  {
    "serverName": "documents",
    "transport": "streamable-http",
    "url": "https://mcp.example.com/mcp",
    "permissions": { "tools": ["search"] }
  }
]
```

설정 형식과 서버 이름 중복은 호스트 생성 시 검증합니다. 실제 연결은 응답을 시작할 때 수행하며, 모델별 에이전트는 호스트의 연결을 공유합니다. 실행마다 도구 목록을 갱신하고, 연결·조회 실패 시 생성을 시작하지 않습니다. 다음 실행에서는 실패한 연결을 새로 만듭니다. `dispose()`는 연결 중인 작업을 취소하고 MCP 세션과 stdio 프로세스를 정리합니다. HTTP 요청으로 서버 설정이나 실행 명령을 받지 않습니다.

## Agent Plugins

`createAgentHost({ plugins })`와 `createAgentRuntime(env, { plugins })`는 Agent Plugins 1.0.0 패키지를 로드합니다. 각 설정에 `root`와 설치 인스턴스별 `dataDirectory`를 지정합니다. `mcp`를 명시한 경우에만 MCP 서버를 실행합니다. 호스트가 스킬 등록과 도구 조합, 종료 시 연결 정리를 담당합니다. 지원 범위와 권한 설정은 [Agent Plugins 문서](../agent-plugins/README.md)를 참고하세요.

## 서브에이전트

호스트는 기본적으로 `delegate_task` 도구를 제공하고 같은 응답의 도구 호출을 병렬로 실행합니다. 모델이 작업을 위임하면 같은 모델과
도구를 사용하는 자식이 독립된 대화에서 실행하고 최종 답변을 돌려줍니다.
`createAgentHost({ ..., subagents: false })` 또는 `createAgentRuntime(env, { subagents: false })`로
비활성화할 수 있습니다. 실행과 취소, 저장 방식은 [서브에이전트 문서](../agent/README.md#서브에이전트)를 참고하세요.
