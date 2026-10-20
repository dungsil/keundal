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
