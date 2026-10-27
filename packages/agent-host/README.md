# @keundal/agent-host

주입받은 `llm`, `session`, `generation`, `agent` 서비스로 실행·제목·대화 API를 제공합니다. LLM SDK, 저장소 공급자, 기본 에이전트 구현에는 의존하지 않습니다.

```ts
import { createAgentHost } from '@keundal/agent-host'
import agentPlugin from '@keundal/plugin-agent-chat'
import openaiPlugin from '@keundal/plugin-llm-openai'
import memoryStorePlugin from '@keundal/plugin-store-memory'

const host = await createAgentHost({
  model: 'gpt-4.1-mini',
  models: [{ id: 'gpt-4.1-mini', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 4_096 }],
  async setup(ctx) {
    await ctx.plugin(openaiPlugin, { apiKey: process.env.OPENAI_API_KEY! })
    await ctx.plugin(memoryStorePlugin)
  },
  mountAgent: async (ctx, config) => ctx.plugin(agentPlugin, config)
})
// 사용이 끝나면 await host.dispose()
```

`setup`과 `mountAgent`는 전달받은 컨텍스트에 플러그인을 등록합니다. 초기화 실패, 에이전트 등록 실패, 호스트 종료 시 해당 범위를 정리합니다. `host.services`는 `run`, `steer`, `cancel`, `subscribe`, `session`, `generation`, `models`, `title`을 제공합니다. 모델은 `models`에 등록한 ID만 사용할 수 있습니다.

호스트는 대화마다 실행을 하나만 허용합니다. `steer(runId, messages)`는 실행 중인 실행의 지시 대기열에 메시지를 넣고, `cancel(runId)`은 실행을 취소합니다. `subscribe(runId, { afterSequence })`는 journal을 재생한 뒤 새 기록을 이어서 전달합니다.

`mountAgent`는 모델 ID와 출력 예산만 받습니다. 도구와 반복 횟수 같은 구현별 정책은 앱의 조립 함수에서 추가합니다. 호스트는 `AgentConfig`나 공통 루프에 의존하지 않습니다.

`@keundal/agent-host/contracts`는 호스트 계약만 내보냅니다. `@keundal/agent-host/http`의 `createAgentApp(services, { token })`은 인증, 본문 크기 제한, AG-UI SSE를 제공하는 Node.js 요청 리스너입니다.

| 경로                                      | 동작                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /runs`                              | 실행을 시작하고 journal을 SSE로 전달합니다. 같은 대화에 실행이 있으면 `409`입니다. |
| `GET /runs/:runId/events?afterSequence=N` | `N` 다음의 journal을 전달합니다. 실행 중이면 새 기록을 이어서 전달합니다.          |
| `POST /runs/:runId/steer`                 | 실행 중이면 지시를 넣고 `202`, 아니면 `409`를 돌려줍니다.                          |
| `POST /runs/:runId/cancel`                | 실행을 취소합니다.                                                                 |

SSE 프레임의 `id`는 journal `sequence`입니다. 스트림을 연 뒤 연결이 끊겨도 실행은 계속됩니다. 실행을 멈추려면 `cancel`을 호출합니다. 자세한 보장 범위는 [실행 제어 문서](../../docs/run-control.md)를 참고합니다.

환경 변수 처리와 기본 LLM·SQLite 구성은 [`@keundal/agent-runtime-node`](../agent-runtime-node/README.md)로 분리했습니다.

## 기능별 HTTP 확장

호스트는 `setup(ctx)`를 실행하기 전에 `ctx.hostHttp`를 제공합니다. 기능 플러그인은 `inject: ['hostHttp']`를 선언하고 `ctx.hostHttp.register(ctx, 'reports', { handle })`로 최상위 경로 영역을 등록합니다. 등록한 플러그인을 해제하면 경로도 사라집니다. 중복 영역과 호스트가 소유한 `runs`, `threads`, `models` 등의 영역은 등록할 수 없습니다.

`handle`은 `HostHttpRequest`의 요청·응답·URL·경로 조각·취소 신호와 `body()`를 받습니다. `body()`는 호스트의 본문 크기 제한을 적용합니다. `RequestBodyTooLargeError`는 호스트까지 전달해야 `413`으로 응답합니다. 연결이 끊기면 취소 신호를 전달하며, 플러그인 해제 시 진행 중인 작업을 취소하는 책임은 플러그인에 있습니다.

기본 인증은 기존 Bearer 토큰입니다. `<video>`처럼 헤더를 붙일 수 없는 읽기 요청은 플러그인이 선택적으로 `authorize({ request, url })`를 제공할 수 있습니다. 이 함수는 해당 영역에서만 적용되며, 메서드·경로·대상 자원에 제한한 만료형 자격 증명만 허용해야 합니다. 전체 API 토큰을 URL로 받지 않습니다. CORS·캐시 정책과 기본 경로의 인증은 바뀌지 않습니다.

미디어의 `/media` API는 [`@keundal/plugin-media`](../plugin-media/README.md)가 이 확장 지점에 등록합니다. 호스트는 미디어 계약이나 구현에 의존하지 않습니다.
