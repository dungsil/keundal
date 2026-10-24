# @keundal/agent-plugins

[Agent Plugins 1.0.0](https://agent-plugins.org/specification) 형식의 로컬 디렉터리를 읽고 Keundal의 스킬과 MCP 도구에 연결합니다. `plugin.json`을 먼저 검증한 뒤 `skills/`의 바로 아래 디렉터리와 루트 `mcp.json`을 탐색합니다. 초안인 1.1.0은 지원하지 않습니다.

## 웹 UI에서 사용

웹 앱의 **설정 → 에이전트 플러그인 → 폴더 가져오기**에서 `plugin.json`이 있는 폴더를 선택합니다.
웹 앱은 매니페스트, `skills/*/SKILL.md`, `mcp.json`만 읽고 브라우저에 저장합니다. 보조 파일과 스크립트는 읽거나 실행하지 않습니다.
가져올 텍스트 파일의 합계는 4 MiB 이하여야 합니다.

가져온 플러그인은 비활성 상태이며 MCP 권한도 없습니다. 스킬, 서버 주소, 진단을 확인한 뒤 플러그인을 활성화합니다.
HTTP MCP를 사용하려면 **MCP 권한**에서 허용할 도구와 리소스를 지정합니다. 서버는 CORS로 브라우저의 origin을 허용해야 합니다.
stdio와 SSE는 진단을 표시하고 건너뜁니다. 설정을 바꾸면 진행 중인 응답을 중단하고 다음 응답부터 적용합니다.
업데이트하려면 기존 플러그인을 삭제한 뒤 폴더를 다시 가져옵니다.

브라우저에 저장한 플러그인은 원격 에이전트에 전달하지 않습니다. 원격 연결에서는 아래의 호스트 설정을 사용합니다.
`@keundal/agent-plugins/browser`의 `inspectAgentPlugin(files)`는 Node API 없이 같은 메타데이터 검증을 적용하며 MCP 서버에 연결하지 않습니다.

YAML 파서는 `SKILL.md`의 frontmatter를 검사할 때 불러옵니다. 스킬이 없는 플러그인의 매니페스트나 MCP 설정만 검사할 때는 파서를 불러오지 않습니다. YAML 구문 오류는 해당 스킬의 진단으로 기록하며, 다른 정상 스킬은 계속 제공합니다.

## 호스트에 연결

```ts
import { createNodeAgentHost, createNodeComposition } from '@keundal/agent-runtime-node'

const host = await createNodeAgentHost(
  {
    provider: 'openai',
    apiKey: process.env.OPENAI_API_KEY!,
    model: 'your-model',
    sqlitePath: '.data/keundal.sqlite',
    plugins: [
      {
        root: '/installed/plugins/reports',
        dataDirectory: '/data/plugins/reports-instance',
        mcp: { permissions: { reports: { tools: ['search'] } } }
      }
    ]
  },
  createNodeComposition
)

// 스킬은 skill 도구로 읽고 MCP 도구는 기존 에이전트 실행 루프에서 호출합니다.
console.log(host.plugins.flatMap((plugin) => plugin.diagnostics))
await host.dispose()
```

`createAgentRuntime(env, { plugins, compose: createNodeComposition })`에서도 같은 설정을 전달할 수 있습니다. 기존 `tools`와 플러그인의 도구를 함께 사용합니다. 플러그인 설정이 없으면 기존 호스트 동작을 유지합니다.

## 직접 조합

```ts
import { loadAgentPlugin } from '@keundal/agent-plugins'
import agentPlugin from '@keundal/plugin-agent-chat'
import skillPlugin from '@keundal/plugin-skill'

const plugin = await loadAgentPlugin({
  root: '/installed/plugins/reports',
  dataDirectory: '/data/plugins/reports-instance'
})

// ctx에는 LLM과 저장소 서비스를 먼저 등록합니다.
await ctx.plugin(skillPlugin, { providers: [plugin.skillProvider] })
ctx.fiber.effect(() => () => plugin.close())
await ctx.plugin(agentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  skills: true,
  tools: (options) => plugin.tools(options)
})
```

`mcp` 설정을 생략하면 서버를 시작하지 않습니다. 설정하면 stdio와 Streamable HTTP 서버를 연결하며, 도구와 리소스 권한은 서버별로 명시합니다. 권한을 생략한 서버에는 도구와 리소스 접근을 허용하지 않습니다. 연결 자체는 하므로 신뢰하는 패키지만 활성화해야 합니다. 레거시 SSE 서버는 진단을 남기고 건너뜁니다.

## 검증과 오류 처리

- `$schema`는 1.0.0의 정식 식별자와 일치해야 합니다. 스키마는 네트워크에서 가져오지 않습니다. 매니페스트가 잘못되면 플러그인 전체를 거부합니다.
- 알 수 없는 매니페스트 필드와 객체가 아닌 `extensions`는 진단을 남기고 무시합니다. 클라이언트별 확장은 구현하지 않으며 해당 값은 검사하지 않습니다.
- 구성요소 위치가 잘못되면 해당 종류만 비활성화합니다. 개별 스킬이나 MCP 서버의 오류는 다른 구성요소의 로딩을 막지 않습니다. 연결 후 도구 목록 조회가 실패해도 다른 서버의 도구는 제공합니다.
- 플러그인의 파일을 읽기 전에 실제 경로가 루트 안에 있는지 검사합니다. 내부 심볼릭 링크는 허용하고 외부 링크는 거부합니다. 스킬 본문을 읽을 때도 다시 검사합니다. 실행 중인 패키지 파일을 다른 프로세스가 동시에 바꾸는 환경을 격리하는 기능은 아닙니다.
- 스킬 이름은 디렉터리 이름과 일치해야 합니다. 이름·설명 길이와 선택적 메타데이터를 검사합니다. 유니코드 스킬 이름은 기존 도구 계약에 맞게 안정적인 `skill-<해시>` 별칭으로 노출합니다. 같은 이름의 스킬은 기존 레지스트리 규칙에 따라 먼저 등록한 공급자가 제공합니다.
- 스킬을 읽으면 원래 `SKILL.md` 전체를 반환합니다. 보조 파일을 자동으로 읽거나 스크립트를 실행하지 않습니다. `allowed-tools` 값으로 호스트 권한을 확대하지 않습니다.

테스트에서 Windows의 심볼릭 링크 생성이 `EPERM`으로 거부되면 해당 테스트만 사유를 표시하고 건너뜁니다. 링크를 만들 수 있는 Windows와 다른 운영체제에서는 보안 검사를 실행합니다. 다른 오류와 보안 검증 실패는 테스트 실패로 처리합니다.

## MCP 실행

stdio는 셸을 거치지 않고 실행 파일과 인자를 분리합니다. `./` 명령은 플러그인 내부 파일로 해석하고, 단일 실행 파일 이름은 플랫폼의 검색 규칙을 따릅니다. `cwd`의 기본값은 플러그인 루트입니다.

`${PLUGIN_ROOT}`와 `${PLUGIN_DATA}`는 `args`, `env` 값, `cwd`에서만 한 번 치환합니다. 다른 변수 표기는 그대로 둡니다. `cwd`는 선택한 루트 안에 있어야 하지만 인자와 환경 변수 값은 불투명한 문자열로 전달합니다. `PLUGIN_ROOT`와 `PLUGIN_DATA`를 서버 설정에서 재정의할 수 없습니다.

`dataDirectory`는 호출자가 설치 인스턴스마다 다른 영속 경로로 지정합니다. 플러그인을 업데이트할 때도 같은 경로를 전달해야 합니다. stdio 실행 전에 디렉터리를 만들고 쓰기 권한을 확인하며, `close()`는 이 데이터를 삭제하지 않습니다.

원격 URL은 HTTPS 또는 루프백 HTTP만 허용하고 사용자 정보와 fragment를 거부합니다. 중복 헤더와 잘못된 헤더를 거부하며 URL과 헤더의 변수를 치환하지 않습니다. 구성된 헤더가 다른 출처로 전달되지 않도록 리디렉션을 거부합니다. OAuth 로그인과 자격 증명 저장 UI는 제공하지 않습니다.

`close()`는 연결을 닫고 스킬 카탈로그와 도구 공급자를 무효화합니다. 반복 호출과 `await using`을 지원합니다. 설치·업데이트·마켓플레이스·권한 승인 UI는 이 패키지의 범위에 포함하지 않습니다.
