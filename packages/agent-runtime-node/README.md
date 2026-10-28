# @keundal/agent-runtime-node

Node.js 환경 변수를 읽고 호스트와 HTTP 요청 리스너를 조립합니다. 기본 LLM 공급자, SQLite 저장소, 기본 에이전트 선택은 `createNodeComposition`에 있습니다.

```ts
import { createAgentRuntime, createNodeComposition } from '@keundal/agent-runtime-node'
const runtime = await createAgentRuntime(process.env, { compose: createNodeComposition })
// runtime.app을 HTTP 서버에 연결하고 종료 시 await runtime.dispose()
```

`createNodeAgentHost(options, compose)`는 환경 변수를 읽지 않고 명시한 설정으로 같은 구성을 만듭니다. `compose`를 바꾸면 저장소·LLM·에이전트를 교체할 수 있습니다. SQLite 경로의 기본값은 `.data/keundal.sqlite`이며, 기본 SQLite 구성을 선택했을 때만 디렉터리를 생성합니다.

`KEUNDAL_MODEL`, 공급자 API 키, `KEUNDAL_API_TOKEN`과 기존 환경 변수 형식은 유지합니다. API 키 없이 연결할 때는 `KEUNDAL_PROVIDER`를 명시합니다. 자세한 설정은 [웹 앱 문서](../../apps/web/README.md)를 참고합니다.

## OS 샌드박스

웹의 Node.js API와 데스크톱 sidecar는 `@keundal/agent-runtime-node/sandbox`의 `createSandboxedAgentRuntime()`으로 실행 호스트 전체를 별도 프로세스에 조립합니다. 외부 모듈의 import, Cordis 등록, 도구 팩토리, Shell과 MCP stdio 프로세스는 모두 OS 격리 이후에 실행합니다. 기존 플러그인 형식과 서비스 교체 계약을 유지하며 플러그인을 도구 팩토리로 제한하지 않습니다. 위의 `createAgentRuntime()`과 `createNodeAgentHost()`는 신뢰한 코드의 직접 조립 API이며 자체적으로 격리하지 않습니다.

현재 기본 공급자는 Linux의 bubblewrap입니다. [설치·namespace 요구 사항](../plugin-sandbox-linux/README.md#linux-ci)을 먼저 충족해야 합니다. Windows·macOS 공급자는 아직 없으며 해당 OS의 로컬 실행 호스트는 시작을 거부합니다. 격리 도구나 정책이 없거나 시작에 실패해도 비격리 프로세스로 대체하지 않습니다. 웹의 브라우저 실행 방식과 원격 호스트 연결은 이 변경의 대상이 아닙니다.

운영자가 작업공간 밖의 JSON 파일을 만들고 `KEUNDAL_SANDBOX_CONFIG`에 절대 경로를 지정합니다.

```json
{
  "workspace": "/home/alice/projects/example",
  "readOnlyPaths": ["/home/alice/keundal-plugins"],
  "writablePaths": ["/home/alice/.local/share/com.keundal.desktop"],
  "allowedHosts": ["api.openai.com:443"],
  "environment": {}
}
```

- `workspace`는 실제 경로로 정규화한 절대 디렉터리이며 자식 프로세스의 현재 디렉터리입니다. 작업공간과 `writablePaths`만 쓰기 가능합니다. SQLite 경로, 관리하는 외부 모듈과 스킬 데이터도 이 범위 안에 두어야 합니다. 기존 데이터는 자동으로 옮기거나 삭제하지 않습니다.
- `readOnlyPaths`는 외부 모듈과 의존성 등 필요한 경로만 노출합니다. 루트·시스템 경로의 광범위한 권한은 거부합니다. 사용자 홈 전체도 허용하지 마세요. 추가 경로는 시작 전에 존재해야 합니다. 작업공간 밖의 심볼릭 링크를 사용하려면 실제 대상 경로도 허용해야 합니다.
- 신뢰한 부모의 설치 디렉터리·실행 파일·샌드박스 정책은 쓰기 권한과 겹칠 수 없습니다. 앱 설치 디렉터리와 코딩 대상 작업공간을 분리합니다. 개발 중인 앱 자신의 소스 트리를 작업공간으로 허용하여 watcher가 외부 코드를 부모에서 다시 실행하게 해서는 안 됩니다. 별도로 로드하는 부모 코드와 설정도 쓰기 권한 밖에 둡니다.
- 작업공간과 추가 권한에 기존 Unix 소켓·특수 파일·복수 하드링크가 있으면 시작을 거부합니다. pnpm 등의 하드링크 기반 의존성도 해당하므로 필요하면 독립된 일반 파일로 배치합니다. 런타임의 `/usr`, `/bin`, `/lib`, `/lib64`와 Node 실행 파일은 신뢰한 읽기 전용 코드로 허용하며 비밀 파일을 두지 않습니다.
- 이 공급자는 살아 있는 디렉터리를 bind mount하며 스냅샷을 만들지 않습니다. 운영자는 실행 중 다른 호스트 프로세스가 마운트에 외부 파일의 하드링크·호스트 서비스 소켓 등 새 권한을 삽입하지 않도록 해야 합니다. 시작 전 검사는 그런 동시 변경의 보안 경계가 아닙니다. 이를 보장할 수 없는 공유 작업공간에는 별도 복사본이나 전용 파일시스템을 사용해야 합니다. 악성 호스트 프로세스나 커널 취약점까지 방어하지 않습니다.
- `allowedHosts`는 정확한 `호스트:포트` 목록이며 생략하면 모든 외부 네트워크를 차단합니다. LLM·MCP·외부 도구에 필요한 목적지를 운영자가 허용합니다. HTTP 프록시와 CONNECT만 중계하며 직접 TCP·UDP는 차단합니다. Node fetch와 프록시 환경 변수를 지원하는 도구는 중계를 사용합니다. 다른 네트워크 클라이언트는 HTTP 프록시를 설정해야 하며 자동으로 우회하지 않습니다. 허용한 DNS 이름의 현재 주소로 접속하므로 IP 고정이나 사설 주소 차단 정책은 아닙니다.
- 부모 환경 전체를 상속하지 않습니다. 기존 LLM·HTTP·저장소·플러그인·승인 설정에 필요한 환경과 `environment`에 운영자가 명시한 항목만 전달합니다. 실행 호스트 안의 플러그인끼리는 같은 권한과 공급자 자격 증명을 공유합니다. Tool Approval의 허용은 이 OS 정책을 넓히지 않습니다.

부모는 HTTP/SSE와 목적지 제한 프록시만 중계합니다. 자식이 만든 경로로 부모가 접속하지 않고, 부모가 만든 읽기 전용 Unix 소켓으로 역방향 연결합니다. `dispose()`나 부모 종료 시에는 Shell의 분리된 자손까지 PID namespace와 함께 종료합니다. 자식의 잘못된 HTTP 응답은 해당 연결만 종료하며 부모의 다음 요청은 유지합니다. CPU·메모리·디스크 할당량과 seccomp 정책은 아직 제공하지 않습니다.

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

OAuth를 쓰는 호스트는 `mcpAuthentication: { documents: account }`로 서버 이름에 대응하는 `McpOAuth`를 주입합니다. `createNodeAgentHost()`와 `createAgentRuntime()`의 옵션에서 지원하며, JSON 환경 변수에는 계정 컨트롤러나 토큰을 넣지 않습니다. 로그인·콜백 라우트, 사용자 세션 검사와 비밀 저장소는 호스트를 조립하는 앱의 책임입니다. 기본 HTTP API에 공개 OAuth 콜백 경로를 추가하지 않습니다. 호스트가 MCP 연결을 공유하므로 서로 다른 사용자의 계정은 호스트와 저장소도 분리해야 합니다. 재인증으로 기존 전송이 닫히면 해당 실행은 실패하고 다음 실행에서 새 연결을 만듭니다. 자세한 인증 계약은 [MCP 클라이언트 문서](../plugin-mcp-client/README.md#oauth-계정-연결)를 참고합니다.

매니페스트에 `"agent": { "module": "builtin:agent", "config": { "deferredTools": {} } }`를 지정하면 MCP Schema를 검색한 뒤 노출합니다. 기본 도구와 명시한 `options.tools`는 계속 직접 노출합니다. 설정을 생략하면 기존 직접 호출을 유지합니다. 검색 한도와 Trace 계약은 [실행 관측 문서](../../docs/execution-trace.md)를 참고합니다.

## Agent Plugins

`createNodeAgentHost({ ...options, plugins }, createNodeComposition)`와 `createAgentRuntime(env, { plugins, compose: createNodeComposition })`는 Agent Plugins 1.0.0 패키지를 로드합니다. 각 설정에 `root`와 설치 인스턴스별 `dataDirectory`를 지정합니다. `mcp`를 명시한 경우에만 MCP 서버를 실행합니다. 호스트가 스킬 등록과 도구 조합, 종료 시 연결 정리를 담당합니다. 지원 범위와 권한 설정은 [Agent Plugins 문서](../agent-plugins/README.md)를 참고하세요.

## 서브에이전트

기본 Node 조합은 `delegate_task`를 제공하고 같은 응답의 도구 호출을 병렬로 실행합니다.
`createNodeAgentHost({ ...options, subagents: false }, createNodeComposition)`으로 위임을 끌 수 있습니다.
`maxActiveSubagents`의 기본값은 8이며 부모 실행별 동시 자식 수를 제한합니다.
`createAgentRuntime(env, { compose: createNodeComposition, subagents: false })`에도 같은 설정을 전달할 수 있습니다.
자세한 결과 형식과 취소 동작은 [에이전트 문서](../agent-loop/README.md#서브에이전트)를 참고하세요.
