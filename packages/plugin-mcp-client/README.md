# @keundal/plugin-mcp-client

외부 Model Context Protocol(MCP) 서버의 도구와 리소스를 Keundal 에이전트에 연결합니다. Node.js에서 stdio와 Streamable HTTP를 지원합니다. 프로토콜과 전송은 공식 `@modelcontextprotocol/client` SDK로 구현합니다.

## 에이전트에 연결

LLM 플러그인과 저장소 플러그인을 등록한 `ctx`에서 사용합니다.

```ts
import agentPlugin from '@keundal/plugin-agent-chat'
import { McpClient } from '@keundal/plugin-mcp-client'

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

카탈로그의 구조 검사는 JSON으로 해석한 응답에 적용합니다. 별도로 연결 협상과 초기화부터 원시 입력의 바이트 수를 제한합니다. HTTP JSON·오류 본문은 전체 크기를, SSE는 이벤트별 크기를 JSON 해석 전에 검사합니다. SSE의 주석·ID·미완성 행도 포함하며, 작은 이벤트를 계속 받는 정상 스트림에는 연결 전체의 누적 제한을 적용하지 않습니다. stdio는 SDK의 수신 버퍼 한도를 명시하며 협상용 자식 프로세스에도 같은 한도를 적용합니다.

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

Streamable HTTP는 서버 URL과 선택적인 HTTP 헤더를 받습니다. 원격 서버는 기본적으로 HTTPS를 사용해야 합니다. 로컬 HTTP는 `localhost`, `127.0.0.0/8`, `[::1]`에서 허용합니다. 신뢰하는 사내망이나 VPN에서 원격 HTTP가 필요하면 해당 서버 설정에 `allowInsecureHttp: true`를 지정하거나 MCP 설정 화면의 “이 서버의 HTTP 연결 허용”을 켭니다. 이 옵션은 서버별로 저장되며 기본값은 `false`입니다. HTTP는 인증 정보와 MCP 통신 내용을 암호화하지 않습니다. 브라우저의 혼합 콘텐츠 정책은 이 옵션으로 해제되지 않습니다. 자격 증명과 MCP 트래픽이 다른 주소로 전달되지 않도록 HTTP 리디렉션은 항상 거부합니다. 기존 `redirect: 'error'` 설정은 계속 사용할 수 있습니다. 자격 증명은 호출자가 관리합니다.

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

## OAuth 계정 연결

`McpOAuth`는 Streamable HTTP 서버의 Authorization Code + PKCE(S256), 인증 서버 검색, 사전 등록한 공개 클라이언트와 동적 클라이언트 등록을 지원합니다. Node.js 진입점과 브라우저 진입점에서 같은 API를 제공합니다. 클라이언트 비밀을 사용하는 confidential client는 지원하지 않습니다.

```ts
import type { McpCredentialStorage } from '@keundal/mcp'
import { McpClient, McpOAuth } from '@keundal/plugin-mcp-client'

// 앱이 OS 보안 저장소 또는 서버 측 비밀 저장소로 구현합니다.
declare const secureStore: McpCredentialStorage
declare function openExternal(url: string): Promise<void>

const account = new McpOAuth({
  serverUrl: 'https://mcp.example.com/mcp',
  redirectUrl: 'https://app.example.com/oauth/mcp/callback',
  clientId: 'registered-public-client', // 생략하면 동적 등록
  scope: 'issues:read',
  storage: secureStore
})

// 로그인·재인증 버튼에서 호출합니다. 자동 도구 실행에서는 호출하지 않습니다.
async function login() {
  await openExternal(await account.authorize())
}

// 앱의 콜백 처리기가 전체 URL을 전달합니다. code만 전달하면 안 됩니다.
async function completeLogin(callbackUrl: string) {
  await account.complete(callbackUrl)
  return McpClient.connect(
    {
      serverName: 'issues',
      transport: 'streamable-http',
      url: account.serverUrl,
      permissions: { tools: ['search_issues'] }
    },
    { authentication: account }
  )
}
```

`authorize()`는 로그인 URL을 반환하며 창을 직접 열지 않습니다. 로그인 버튼, 외부 브라우저 실행, 콜백 HTTP/IPC 라우트와 사용자 세션 검사는 앱이 소유합니다. 기본 웹·데스크톱 앱은 MCP 설정에서 계정을 연결하며, 웹은 팝업과 메모리 저장을, 데스크톱은 시스템 브라우저와 OS 보안 저장소를 조립합니다. 데스크톱 콜백은 앱이 먼저 연 loopback 리스너의 URL을 사용합니다. 서버 콜백은 신뢰하는 고정 HTTPS URL을 사용하고, 요청의 Host 헤더로 URL을 만들지 않습니다. 브라우저에서 직접 연결하면 MCP 서버와 인증 서버 모두 필요한 CORS를 허용해야 합니다.

`complete()`는 콜백 origin·경로, 고정 query, 중복 응답 매개변수, 무작위 state, 10분 유효 시간과 인증 서버 issuer를 검사합니다. PKCE verifier와 검색 결과는 콜백 왕복 동안 같은 보안 저장소에 보존합니다. 성공·거부·코드 교환 실패 시 state를 소비하여 재사용을 막습니다. 새로운 `authorize()`는 이전 로그인 요청을 무효화하고 인증 서버를 다시 검색합니다.

`status()`는 `disconnected`, `authorizing`, `connected`, `reauthentication-required`를 반환하며 토큰을 노출하지 않습니다. `connected`는 저장된 grant가 있거나 갱신할 수 있다는 뜻이며 서버의 실시간 연결 확인은 아닙니다. `token()`은 요청마다 현재 access token을 읽고 만료 30초 전부터 갱신합니다. refresh token이 없으면 access token 만료 시 재인증을 요구합니다. 회전된 refresh token을 저장하고 같은 컨트롤러의 동시 갱신을 직렬화합니다. 같은 토큰에 대한 동시 401은 중복 갱신하지 않습니다. HTTP 전송은 401 이후 한 번만 다시 요청하며 완료된 도구를 자동 재실행하지 않습니다.

폐기된 grant는 `McpAuthenticationRequiredError`로 알립니다. 인증이 없거나 만료되어도 로그인 창을 자동으로 열지 않습니다. 일시적인 네트워크·인증 서버 오류는 갱신 자격 증명을 보존합니다. 각 OAuth 작업은 30초 네트워크 제한과 선택적인 `{ signal }`을 받습니다. 오류 본문과 토큰을 공개 오류나 SDK 경고에 포함하지 않으며 OAuth 응답 본문은 1MiB로 제한합니다.

`await account.disconnect()`는 저장된 토큰·클라이언트 등록 정보·진행 중인 로그인을 삭제합니다. 연결 해제와 새 로그인 시작은 기존 MCP 전송과 진행 중인 요청을 즉시 중단합니다. 새 grant를 얻은 뒤 새 클라이언트를 연결해야 하므로 다른 계정에 이전 MCP 세션을 재사용하지 않습니다. 원격 서비스의 계정·로그인 세션이나 grant 자체를 철회하는 API는 아닙니다. 이미 발생한 도구의 부작용을 되돌릴 수 없으며 원격 작업의 취소 여부는 서버에 달려 있습니다.

### 자격 증명 저장 경계

- `McpCredentialStorage`는 필수입니다. 기본 평문 파일·localStorage·IndexedDB 저장이나 안전하지 않은 저장소로의 대체 동작은 제공하지 않습니다. 데스크톱은 OS Keychain/Credential Manager/Secret Service, 서버는 접근 제어와 암호화를 적용한 비밀 저장소를 주입합니다. 이 패키지는 구체적인 저장소 공급자를 선택하지 않습니다.
- 서버 설정에는 URL과 권한만 저장합니다. 토큰, 동적 등록의 비밀, PKCE verifier와 state를 `McpClientConfig`, 환경 변수, 대화, 모델 입력, 브라우저 저장소에 넣지 않습니다. `McpSettingsStorage`와 OAuth 저장소는 서로 다른 계약입니다.
- 저장 키는 정확한 MCP URL, 콜백 URL, client ID와 scope에 묶입니다. 다중 사용자 서버에서는 저장소 자체도 인증된 사용자별로 격리하고 로그인·콜백·연결 해제 경로에 접근 제어를 적용합니다. 컨트롤러 하나를 서로 다른 사용자에게 공유하지 않습니다.
- 서버·사용자·설정별로 살아 있는 `McpOAuth` 인스턴스는 하나만 유지합니다. 여러 MCP 클라이언트는 같은 인스턴스를 공유합니다. 다중 프로세스 배포는 해당 계정의 작업을 단일 소유자로 라우팅하거나 외부 잠금으로 직렬화해야 합니다. `load`/`save`만으로 분산 잠금을 제공하지 않습니다.
- OAuth는 `allowInsecureHttp`를 무시하고 HTTPS 또는 loopback HTTP만 허용합니다. OAuth HTTP 리디렉션도 거부합니다. 다른 MCP URL로 토큰을 보내거나 정적 `Authorization` 헤더와 혼용할 수 없습니다. 서버 배포에서는 신뢰하는 MCP 주소를 허용 목록으로 제한하고 검색된 주소에 대한 네트워크 접근 정책도 적용합니다.

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

리소스 목록과 템플릿은 페이지마다 검사한 뒤 합치며, 페이지 전체의 누적 JSON 크기에 같은 한도를 적용합니다. 따라서 반환할 항목에서 제외되는 URI와 페이지 메타데이터도 조회 예산을 사용합니다. 조회는 최대 64페이지이며 반복되는 커서는 거부합니다. 리소스 조회는 SDK 응답 캐시에 결과를 복사하지 않습니다. 만료된 요청의 늦은 응답이나 중복 응답도 SDK 오류로 재직렬화되지 않도록 전체 응답을 검사합니다. 전체 응답과 원시 입력의 상한은 `maxResultBytes`와 1 MiB 중 큰 값의 두 배입니다. 기본 원시 입력 한도는 2 MiB이며, 작은 `maxResultBytes`를 설정해도 정상 초기화와 목록 조회를 위한 이 최소 한도는 유지합니다. HTTP의 `Content-Length`가 본문 한도를 넘으면 읽기 전에 거부하고, 길이가 없거나 압축된 응답도 실제 수신 청크로 검사합니다. 원시 한도를 넘으면 본문을 오류에 포함하지 않고 수신을 중단하며 연결을 닫습니다. 이미 연결이 끊겼으면 `close()`는 HTTP 세션 종료 요청을 다시 보내지 않습니다. 전송 구현이 전달한 청크 자체의 할당과 네이티브 네트워크 버퍼까지 격리하지는 않습니다.

실행 함수는 에이전트의 취소 신호를 MCP 요청에 전달합니다. `close()`는 새 요청을 거부하고 진행 중인 요청을 취소합니다. HTTP 세션이 있으면 종료 요청을 보낸 뒤 연결을 닫고, stdio는 자식 프로세스를 정리합니다. 반복해서 닫아도 같은 종료 작업을 기다립니다. `await using`과 `Symbol.asyncDispose`도 지원합니다.

원격 작업의 취소와 정리 완료 여부는 서버 구현에 달려 있습니다. 취소는 이미 발생한 부작용을 되돌리지 않습니다. 연결이 끊기면 새 클라이언트를 생성합니다. 자동 재접속, 도구 재실행, 서버 지시문 삽입, MCP prompts, sampling, elicitation, task 실행, 레거시 SSE 전송은 지원하지 않습니다.

## 연결 확인

`McpClient.probe(config, { signal })`는 설정으로 연결해 서버가 알려 주는 도구 이름과 설명, 리소스 지원 여부와 개수를 `McpProbeResult`로 반환하고 연결을 닫습니다. 설정의 `permissions`는 무시하며 실행 함수를 만들지 않습니다. 도구 목록과 리소스 목록만 요청하고 `tools/call`과 `resources/read`는 요청하지 않습니다. 서버가 해당 기능을 알리지 않으면 목록을 요청하지 않습니다.

`timeoutMs`는 연결과 조회를 합친 전체 시간 제한이며, 넘으면 `TimeoutError`로 실패합니다. `signal`이 중단되면 시간 제한을 기다리지 않고 실패합니다. 성공, 실패, 취소, 시간 초과 어느 경우에도 연결을 닫습니다. 응답하지 않는 서버의 세션 종료 요청은 3초까지만 기다립니다. 도구 목록은 `maxResultBytes`와 도구 수 한도를 따르고, 리소스 목록은 `maxResultBytes`를 따릅니다. 인스턴스 메서드 `inspect()`는 이미 연결한 클라이언트에서 같은 조회를 수행합니다. Node.js 진입점은 stdio 설정도 확인하며, 이때 설정한 명령을 실행합니다. 브라우저 진입점은 stdio를 거부합니다.

## 브라우저에서 사용

`@keundal/plugin-mcp-client/browser`에서 `McpClient`를 가져오면 Node.js 전용 모듈 없이 Streamable HTTP에 연결할 수 있습니다. 이 진입점은 stdio를 거부합니다. 브라우저의 CORS와 보안 컨텍스트 정책을 따르며, 서버는 앱 origin과 MCP 요청 헤더를 허용해야 합니다. 도구 이름과 권한, 취소 계약은 Node.js 진입점과 같습니다.

`@keundal/mcp`의 `parseMcpServers(value, allowStdio?)`는 저장한 서버 배열을 검증하고 복사합니다. 두 클라이언트 진입점도 이 함수를 내보냅니다. 브라우저 설정을 검증할 때는 두 번째 인자로 `false`를 전달합니다.
