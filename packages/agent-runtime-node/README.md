# @keundal/agent-runtime-node

Node.js 환경 변수를 읽고 호스트와 HTTP 요청 리스너를 조립합니다. 기본 LLM 공급자, SQLite 저장소, 기본 에이전트 선택은 `createNodeComposition`에 있습니다.

```ts
import { createAgentRuntime, createNodeComposition } from '@keundal/agent-runtime-node'
const runtime = await createAgentRuntime(process.env, { compose: createNodeComposition })
// runtime.app을 HTTP 서버에 연결하고 종료 시 await runtime.dispose()
```

`createNodeAgentHost(options, compose)`는 환경 변수를 읽지 않고 명시한 설정으로 같은 구성을 만듭니다. `compose`를 바꾸면 저장소·LLM·에이전트를 교체할 수 있습니다. SQLite 경로의 기본값은 `.data/keundal.sqlite`이며, 기본 SQLite 구성을 선택했을 때만 디렉터리를 생성합니다.

`KEUNDAL_MODEL`, 공급자 API 키, `KEUNDAL_API_TOKEN`과 기존 환경 변수 형식은 유지합니다. API 키 없이 연결할 때는 `KEUNDAL_PROVIDER`를 명시합니다. 자세한 설정은 [웹 앱 문서](../../apps/web/README.md)를 참고합니다.

## MCP 연결

`createNodeAgentHost(options, createNodeComposition)`의 `mcpServers` 옵션에 `@keundal/mcp`의 서버 설정 배열을 전달합니다. 환경 설정을 사용하는 웹 서버와 데스크톱 sidecar에서는 같은 배열을 JSON으로 직렬화한 `KEUNDAL_MCP_SERVERS`를 사용합니다. 설정을 생략하면 MCP에 연결하지 않습니다.

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

`createNodeAgentHost({ ...options, plugins }, createNodeComposition)`와 `createAgentRuntime(env, { plugins, compose: createNodeComposition })`는 Agent Plugins 1.0.0 패키지를 로드합니다. 각 설정에 `root`와 설치 인스턴스별 `dataDirectory`를 지정합니다. `mcp`를 명시한 경우에만 MCP 서버를 실행합니다. 호스트가 스킬 등록과 도구 조합, 종료 시 연결 정리를 담당합니다. 지원 범위와 권한 설정은 [Agent Plugins 문서](../agent-plugins/README.md)를 참고하세요.

## 서브에이전트

기본 Node 조합은 `delegate_task`를 제공하고 같은 응답의 도구 호출을 병렬로 실행합니다.
`createNodeAgentHost({ ...options, subagents: false }, createNodeComposition)`으로 위임을 끌 수 있습니다.
`maxActiveSubagents`의 기본값은 8이며 부모 실행별 동시 자식 수를 제한합니다.
`createAgentRuntime(env, { compose: createNodeComposition, subagents: false })`에도 같은 설정을 전달할 수 있습니다.
자세한 결과 형식과 취소 동작은 [에이전트 문서](../agent/README.md#서브에이전트)를 참고하세요.
