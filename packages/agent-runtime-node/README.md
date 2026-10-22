# @keundal/agent-runtime-node

Node.js 환경 변수를 읽고 호스트와 HTTP 요청 리스너를 조립합니다. 기본 LLM 공급자, SQLite 저장소, 기본 에이전트 선택은 `createNodeComposition`에 있습니다.

```ts
import { createAgentRuntime, createNodeComposition } from '@keundal/agent-runtime-node'
const runtime = await createAgentRuntime(process.env, { compose: createNodeComposition })
// runtime.app을 HTTP 서버에 연결하고 종료 시 await runtime.dispose()
```

`createNodeAgentHost(options, compose)`는 환경 변수를 읽지 않고 명시한 설정으로 같은 구성을 만듭니다. `compose`를 바꾸면 저장소·LLM·에이전트를 교체할 수 있습니다. SQLite 경로의 기본값은 `.data/keundal.sqlite`이며, 기본 SQLite 구성을 선택했을 때만 디렉터리를 생성합니다.

`KEUNDAL_MODEL`, 공급자 API 키, `KEUNDAL_API_TOKEN`과 기존 환경 변수 형식은 유지합니다. API 키 없이 연결할 때는 `KEUNDAL_PROVIDER`를 명시합니다. 자세한 설정은 [웹 앱 문서](../../apps/web/README.md)를 참고합니다.

## 런타임 플러그인

기본 구성은 `KEUNDAL_PLUGIN_CONFIG`가 가리키는 JSON 파일을 시작할 때 읽습니다. 경로는 절대 경로 또는 현재 작업 디렉터리 기준 상대 경로입니다. 변수를 설정하지 않으면 현재 작업 디렉터리의 `keundal.plugins.json`을 찾습니다. 파일이 없으면 기본 구성을 사용합니다.

```json
{
  "plugins": [
    { "module": "builtin:llm", "config": { "provider": "openai" } },
    { "module": "builtin:store", "config": { "path": ".data/custom.sqlite" } },
    { "module": "./plugins/metrics.mjs" }
  ],
  "agent": { "module": "builtin:agent" },
  "tools": [{ "module": "./plugins/tools.mjs", "export": "createTools" }]
}
```

외부 플러그인은 매니페스트 파일 기준 상대 경로, 절대 경로, `file:` URL 또는 설치된 패키지 이름으로 지정합니다. 매니페스트가 없는 프로그램 구성은 `runtimePlugins`와 `runtimePluginBasePath` 옵션을 사용합니다. 설정 파일이 잘못됐거나 모듈을 불러오지 못하면 호스트 생성을 거부하며 기본 구성으로 바꾸지 않습니다.

`builtin:llm`, `builtin:store`, `builtin:skills`, `builtin:agent`는 기본 플러그인 별칭입니다. `tools` 항목은 각 도구 목록 조회 때 실행됩니다. 매니페스트에 `tools`가 있으면 `options.tools`와 결합합니다. 없으면 `defaultTools`를 `options.tools`와 결합합니다. MCP 도구와 Agent Plugins 도구도 함께 전달됩니다.

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

매니페스트에 `"agent": { "module": "builtin:agent", "config": { "deferredTools": {} } }`를 지정하면 MCP Schema를 검색한 뒤 노출합니다. 기본 도구와 명시한 `options.tools`는 계속 직접 노출합니다. 설정을 생략하면 기존 직접 호출을 유지합니다. 검색 한도와 Trace 계약은 [실행 관측 문서](../../docs/execution-trace.md)를 참고합니다.

## Agent Plugins

`createNodeAgentHost({ ...options, plugins }, createNodeComposition)`와 `createAgentRuntime(env, { plugins, compose: createNodeComposition })`는 Agent Plugins 1.0.0 패키지를 로드합니다. 각 설정에 `root`와 설치 인스턴스별 `dataDirectory`를 지정합니다. `mcp`를 명시한 경우에만 MCP 서버를 실행합니다. 호스트가 스킬 등록과 도구 조합, 종료 시 연결 정리를 담당합니다. 지원 범위와 권한 설정은 [Agent Plugins 문서](../agent-plugins/README.md)를 참고하세요.

## 서브에이전트

기본 Node 조합은 `delegate_task`를 제공하고 같은 응답의 도구 호출을 병렬로 실행합니다.
`createNodeAgentHost({ ...options, subagents: false }, createNodeComposition)`으로 위임을 끌 수 있습니다.
`maxActiveSubagents`의 기본값은 8이며 부모 실행별 동시 자식 수를 제한합니다.
`createAgentRuntime(env, { compose: createNodeComposition, subagents: false })`에도 같은 설정을 전달할 수 있습니다.
자세한 결과 형식과 취소 동작은 [에이전트 문서](../agent-loop/README.md#서브에이전트)를 참고하세요.
