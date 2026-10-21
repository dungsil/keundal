# @keundal/mcp

외부 Model Context Protocol(MCP) 서버의 도구와 리소스를 Keundal 에이전트에 연결합니다. Node.js에서 stdio와 Streamable HTTP를 지원합니다. 프로토콜과 전송은 공식 `@modelcontextprotocol/client` SDK로 구현합니다.

## 에이전트에 연결

LLM 플러그인과 저장소 플러그인을 등록한 `ctx`에서 사용합니다.

```ts
import agentPlugin from '@keundal/agent'
import { McpClient } from '@keundal/mcp'

const mcp = await McpClient.connect({
  serverName: 'documents',
  transport: 'stdio',
  command: 'node',
  args: ['/absolute/path/to/mcp-server.js'],
  permissions: {
    tools: ['search'],
    resources: ['docs://guide']
  }
})

// MCP 연결은 이를 생성한 플러그인이 해제될 때 닫습니다.
ctx.fiber.effect(() => () => mcp.close())

await ctx.plugin(agentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  tools: (options) => mcp.tools(options)
})
```

`tools()`는 현재 도구 목록을 조회하고 `ExecutableTool[]`을 반환합니다. SDK가 목록의 모든 페이지를 조회하며, 도구 목록은 SDK 캐시에 저장하지 않습니다. 에이전트는 실행 시작마다 공급자를 호출하고, 반환된 목록을 그 실행의 후속 생성까지 유지합니다. 서버의 도구 추가와 제거는 다음 실행부터 반영합니다. 조회가 실패하면 해당 실행은 생성을 시작하지 않습니다.

도구 목록은 조회별로 최대 256개, 전체 응답의 JSON 크기 합계 1MiB, 정의당 64KiB, 설명당 UTF-8 16KiB, 응답 중첩 깊이 32까지 허용합니다. 권한으로 숨기는 도구도 예산에 포함합니다. 전송 계층이 해석한 각 페이지를 SDK의 스키마 검증과 목록 누적 전에 검사하며, 한도를 넘으면 일부 목록을 반환하지 않고 조회 전체를 거부합니다. 동시에 수행하는 조회는 독립된 예산을 사용합니다. SDK의 최대 64페이지 제한도 유지합니다.

이 제한은 전송 계층에서 이미 수신하고 JSON으로 해석한 응답에 적용합니다. 원시 HTTP 본문이나 stdio 프레임의 수신·JSON 해석 메모리까지 제한하지는 않습니다.

목록을 고정하려면 기존 배열 설정을 그대로 사용합니다.

```ts
const tools = await mcp.tools()
await ctx.plugin(agentPlugin, { model: 'your-model', maxOutputTokens: 1024, tools })
```

두 서버의 도구는 한 공급자에서 합칩니다. 서버마다 서로 다른 `serverName`을 지정합니다. 같은 이름을 지정해 도구 이름이 중복되면 에이전트가 생성을 시작하기 전에 거부합니다.

```ts
tools: async (options) => [...(await documents.tools(options)), ...(await issues.tools(options))]
```

## 전송 설정

stdio 설정은 `command`, `args`, `env`, `cwd`를 받습니다. 셸을 거치지 않고 실행 파일과 인자를 전달합니다. SDK의 기본 환경에 `env`로 명시한 값을 추가합니다. 부모 프로세스의 전체 환경을 복사하지 않으므로 필요한 자격 증명은 `env`에 명시합니다. 자식 프로세스의 stderr는 출력하지 않습니다.

Streamable HTTP는 서버 URL과 선택적인 HTTP 헤더를 받습니다. `redirect: 'error'`를 지정하면 HTTP 리디렉션을 거부합니다. 자격 증명은 호출자가 관리합니다.

```ts
const remote = await McpClient.connect(
  {
    serverName: 'issues',
    transport: 'streamable-http',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: `Bearer ${token}` },
    permissions: { tools: ['search_issues'] },
    timeoutMs: 30_000
  },
  { signal }
)
```

SDK의 자동 협상으로 지원하는 프로토콜 버전을 선택합니다. stdio 협상은 확인용 자식 프로세스를 먼저 실행할 수 있습니다. `timeoutMs`의 기본값은 60,000ms이며 연결과 각 요청에 적용합니다. `connect()`와 조회 메서드는 선택적인 `signal`을 받습니다.

## 이름과 권한

- 도구의 공개 이름은 `mcp__<serverName>__tool__<원래 이름>`입니다. 서버가 보고한 이름 대신 설정의 `serverName`을 사용합니다.
- 이름은 영문자, 숫자, `_`, `-`만 사용하며 64자 이하로 제한합니다. 치환, 잘림, 구분자 중복이 있으면 서버·종류·원래 이름에서 계산한 해시를 붙입니다.
- 서버에 요청할 때는 공개 이름을 역변환하지 않고, 조회한 원래 이름을 사용합니다. 리소스 도구는 별도의 `resource` 이름 공간을 사용합니다.
- `permissions.tools`는 서버의 원래 도구 이름 목록입니다. `permissions.resources`는 읽기를 허용한 URI의 정확한 목록입니다. 와일드카드 패턴은 해석하지 않습니다.
- 각 권한에 `'*'`를 지정하면 해당 서버의 모든 도구나 리소스를 허용합니다. 생략하거나 빈 배열을 지정하면 차단합니다. 연결할 때 허용 목록을 복사하므로 원본 배열을 바꿔도 권한이 늘어나지 않습니다.
- 권한은 이 클라이언트의 요청 범위를 제한합니다. stdio 프로세스의 파일·네트워크 접근을 격리하거나, 도구 인자별 승인과 서버의 OAuth 권한을 대신하지 않습니다. 신뢰하는 서버만 실행합니다.

## 리소스

리소스를 지원하고 리소스 권한이 있는 서버에는 다음 도구를 추가합니다.

- `mcp__<serverName>__resource__list`: 모든 페이지를 조회한 뒤 허용한 URI만 반환합니다.
- `mcp__<serverName>__resource__read`: `uri`를 받아 읽습니다. 허용하지 않은 URI는 서버에 요청하기 전에 거부합니다.
- `mcp__<serverName>__resource__templates`: 템플릿 목록을 조회합니다. 리소스 권한이 `'*'`일 때만 추가합니다. 템플릿을 확장한 URI를 읽기 도구에 전달합니다.

애플리케이션에서 `listResources()`, `readResource(uri)`, `listResourceTemplates()`를 직접 호출해도 같은 권한을 적용합니다. 연결 시 리소스 본문을 미리 읽거나 대화에 삽입하지 않습니다.

## 결과와 종료

도구 결과는 MCP의 `content`와 `structuredContent`를 포함한 JSON 문자열로 반환합니다. 리소스 결과도 JSON 문자열을 사용합니다. 이미지와 오디오는 JSON에 보존하지만 모델의 이미지·오디오 입력으로 바꾸지 않습니다. 서버의 `isError: true` 응답과 프로토콜 오류는 실행 오류로 전달하며, 에이전트는 성공한 세션 커밋을 수행하지 않습니다.

`maxResultBytes`의 기본값은 1,048,576바이트(1 MiB)이며, 양의 정수로 변경할 수 있습니다. 도구 결과와 직접 조회를 포함한 리소스 결과의 JSON UTF-8 크기를 직렬화 전에 검사합니다. 이스케이프 문자, 구조화 결과, 이미지·오디오 데이터, 메타데이터도 한도에 포함합니다. 중첩 깊이는 64단계로 제한합니다. 한도를 넘으면 결과를 자르거나 원문을 오류에 넣지 않고 실행을 거부합니다. 원격 프로토콜 오류의 메시지와 데이터에도 같은 한도를 적용합니다.

리소스 목록과 템플릿은 페이지마다 검사한 뒤 합치며, 페이지 전체의 누적 JSON 크기에 같은 한도를 적용합니다. 따라서 반환할 항목에서 제외되는 URI와 페이지 메타데이터도 조회 예산을 사용합니다. 조회는 최대 64페이지이며 반복되는 커서는 거부합니다. 리소스 조회는 SDK 응답 캐시에 결과를 복사하지 않습니다. 만료된 요청의 늦은 응답이나 중복 응답도 SDK 오류로 재직렬화되지 않도록 전체 응답을 검사합니다. 전체 응답의 상한은 `maxResultBytes`와 1 MiB 중 큰 값의 두 배이며, 요청과 연결할 수 없는 초과 응답은 버립니다. 이 한도는 전송 계층이 JSON 응답을 해석한 뒤 SDK 결과 검증 전에 적용하므로 전송 계층의 최초 응답 할당까지 제한하지는 않습니다.

실행 함수는 에이전트의 취소 신호를 MCP 요청에 전달합니다. `close()`는 새 요청을 거부하고 진행 중인 요청을 취소합니다. HTTP 세션이 있으면 종료 요청을 보낸 뒤 연결을 닫고, stdio는 자식 프로세스를 정리합니다. 반복해서 닫아도 같은 종료 작업을 기다립니다. `await using`과 `Symbol.asyncDispose`도 지원합니다.

원격 작업의 취소와 정리 완료 여부는 서버 구현에 달려 있습니다. 취소는 이미 발생한 부작용을 되돌리지 않습니다. 연결이 끊기면 새 클라이언트를 생성합니다. 자동 재접속, 도구 재실행, 서버 지시문 삽입, MCP prompts, sampling, elicitation, task 실행, 레거시 SSE 전송은 지원하지 않습니다.

## 참고 구현

[DeepSeek Harness MCP](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/mcp)의 전송 분리, 안정적인 도구 이름, 지연 리소스 조회 방식을 참고했습니다. Harness의 도구 레지스트리와 권한 서비스는 가져오지 않고 Keundal의 `ExecutableTool` 계약에 연결합니다.

## 브라우저에서 사용

`@keundal/mcp/browser`에서 `McpClient`를 가져오면 Node.js 전용 모듈 없이 Streamable HTTP에 연결할 수 있습니다. 이 진입점은 stdio를 거부합니다. 브라우저의 CORS와 보안 컨텍스트 정책을 따르며, 서버는 앱 origin과 MCP 요청 헤더를 허용해야 합니다. 도구 이름과 권한, 취소 계약은 Node.js 진입점과 같습니다.

두 진입점의 `parseMcpServers(value, allowStdio?)`는 저장한 서버 배열을 검증하고 복사합니다. 브라우저 설정을 검증할 때는 두 번째 인자로 `false`를 전달합니다.
