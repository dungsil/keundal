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

// host.services를 HTTP 계층에 연결합니다. 예시는 apps/server를 참고합니다.
```

`host.services`는 HTTP 계층이 사용하는 `run`, `session`, `generation`, `models`, `title`을 제공합니다.
`host.dispose()`는 모델별 에이전트와 Cordis 컨텍스트를 정리합니다.

- [apps/server](../../apps/server/README.md)는 이 패키지를 Node.js HTTP 서버와 sidecar 모드로 노출합니다.
- 모델은 `models`에 등록한 ID만 사용할 수 있습니다.
- 저장소는 SQLite 파일 하나를 사용합니다.
