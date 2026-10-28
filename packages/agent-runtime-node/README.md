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

기본 공급자는 [Linux VM](../plugin-sandbox-vm/README.md)입니다. Linux·Windows·macOS 호스트에서 QEMU로 같은 Linux 실행 환경을 시작하며, 호스트 디렉터리를 마운트하거나 네트워크 어댑터를 연결하지 않습니다. 기존 Cordis 플러그인 형식은 유지하지만 Windows·macOS 전용 실행 파일이나 다른 OS용 native addon은 실행하지 못합니다. 격리 도구나 정책이 없거나 시작에 실패해도 비격리 프로세스나 bubblewrap으로 대체하지 않습니다. 웹의 브라우저 실행 방식과 원격 호스트 연결은 이 변경의 대상이 아닙니다.

운영자는 QEMU·네이티브 파일 브로커·신뢰한 게스트 이미지를 설치하고 `KEUNDAL_SANDBOX_VM_CONFIG`에 자산 설정 파일의 절대 경로를 지정합니다. 설치 방법과 Windows 경로 매핑은 [VM 공급자 문서](../plugin-sandbox-vm/README.md#operator-installation)를 따릅니다. 최소 이미지에는 Node와 BusyBox만 있으므로 git·Python 등 필요한 Linux 도구와 라이브러리는 게스트 이미지에 추가해야 합니다. 앱이 시작할 때 설치하거나 호스트 도구를 대신 실행하지 않습니다.

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
- `readOnlyPaths`는 외부 모듈과 의존성 등 필요한 디렉터리만 복사합니다. 모든 권한은 서로 겹치지 않는 기존 디렉터리여야 하며 게스트 시스템·제어 경로와 겹칠 수 없습니다. 사용자 홈 전체를 허용하지 마세요. 작업공간 밖의 심볼릭 링크를 사용하려면 실제 대상 경로도 허용해야 합니다. Windows에서는 순서대로 `/workspaces/0`, `/workspaces/1` 등에 복사하므로 플러그인 설정에는 게스트에서 해석할 상대 경로를 사용합니다.
- 신뢰한 부모의 설치 디렉터리·실행 파일·샌드박스 정책은 쓰기 권한과 겹칠 수 없습니다. 앱 설치 디렉터리와 코딩 대상 작업공간을 분리합니다. 개발 중인 앱 자신의 소스 트리를 작업공간으로 허용하여 watcher가 외부 코드를 부모에서 다시 실행하게 해서는 안 됩니다. 별도로 로드하는 부모 코드와 설정도 쓰기 권한 밖에 둡니다.
- 시작할 때 네이티브 브로커가 새 일반 파일의 내용만 복사하고, 기존 소켓·특수 파일·복수 하드링크는 거부합니다. pnpm 등의 하드링크 기반 의존성은 독립된 일반 파일로 배치해야 합니다. 심볼릭 링크는 링크 문자열로 옮기며 호스트의 대상을 따라가지 않습니다. 실행 후 호스트가 새 하드링크나 서비스 소켓을 게시해도 VM에는 나타나지 않습니다.
- 파일은 실시간 공유하지 않습니다. 호스트 변경은 다음 시작에 가져오고 VM 변경은 정상 종료에 내보냅니다. 한쪽만 바뀐 내용은 보존하며 양쪽 수정이 충돌하면 거부합니다. 내보내기는 여러 파일을 묶은 트랜잭션이 아니므로 실패 전에 일부 파일이 반영될 수 있습니다. 가져오기·내보내기 중에는 호스트 편집을 멈춰야 하며, 악성 호스트 관리자나 파일시스템 조상 경로의 교체까지 방어하지 않습니다.
- 비정상 종료나 충돌 시 VM 디스크를 지우지 않습니다. 호스트에 아직 없는 생성 파일·세션·부분 응답이 남아 있을 수 있습니다. 다음 시작은 같은 권한 집합의 디스크를 복구·병합하며 LLM이나 도구를 자동으로 재실행하지 않습니다. 초기 시작·복사는 최대 180초, 정상 종료·내보내기는 최대 125초의 예산을 사용합니다.
- `allowedHosts`는 정확한 `호스트:포트` 목록이며 생략하면 모든 외부 네트워크를 차단합니다. LLM·MCP·외부 도구에 필요한 목적지를 운영자가 허용합니다. HTTP 프록시와 CONNECT만 중계하며 직접 TCP·UDP는 차단합니다. Node fetch와 프록시 환경 변수를 지원하는 도구는 중계를 사용합니다. 다른 네트워크 클라이언트는 HTTP 프록시를 설정해야 하며 자동으로 우회하지 않습니다. 허용한 DNS 이름의 현재 주소로 접속하므로 IP 고정이나 사설 주소 차단 정책은 아닙니다.
- 부모 환경 전체를 상속하지 않습니다. 기존 LLM·HTTP·저장소·플러그인·승인 설정에 필요한 환경과 `environment`에 운영자가 명시한 항목만 전달합니다. 실행 호스트 안의 플러그인끼리는 같은 권한과 공급자 자격 증명을 공유합니다. Tool Approval의 허용은 이 OS 정책을 넓히지 않습니다.

부모는 직렬 채널로 HTTP/SSE와 목적지 제한 프록시만 중계합니다. VM이 지정한 호스트 경로에는 접속하지 않으며 호스트 소켓·named pipe나 프로세스를 노출하지 않습니다. 실행 호스트는 게스트 uid/gid 1000으로 시작하고 제어 프로세스·직렬 장치·디스크 장치에 접근할 수 없습니다. `dispose()`나 부모 종료 시에는 Shell의 분리된 자손까지 종료한 뒤 파일을 내보냅니다. 자식의 잘못된 HTTP 응답은 해당 연결만 종료하며 부모의 다음 요청은 유지합니다. VM에는 메모리 1 GiB와 sparse 디스크 8 GiB를 할당하지만 CPU 시간·프로세스 수·전송량·호스트 디스크 사용량의 작업별 할당량은 아직 제공하지 않습니다.

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
