# @keundal/plugin-llm-mock

외부 API 대신 지정한 응답이나 내장 시나리오를 반환하는 LLM 공급자입니다. Node.js와 브라우저에서 같은 플러그인을 사용합니다. API 키가 필요하지 않으며 LLM 요청을 네트워크로 보내지 않습니다.

`session`과 `generation`은 제공하지 않습니다. 에이전트 테스트에서는 `@keundal/plugin-store-memory` 같은 실제 저장소와 조합하세요. 목업의 응답은 모델의 정확도나 실제 공급자의 토큰 계산을 검증하지 않습니다.

## 테스트에서 사용하기

```ts
import agentPlugin from '@keundal/plugin-agent-chat'
import mockLLMPlugin, { MockLLMService } from '@keundal/plugin-llm-mock'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { Context } from 'cordis'

const ctx = new Context()
const llm = await ctx.plugin(mockLLMPlugin, {
  models: { test: { contextWindow: 2000, maxOutputTokens: 200 } },
  inputTokens: 10,
  responses: [{ text: '첫 번째 응답' }, { text: '두 번째 응답' }]
})
const store = await ctx.plugin(memoryStorePlugin)
const agent = await ctx.plugin(agentPlugin, { model: 'test', maxOutputTokens: 100 })

try {
  for await (const event of ctx.agent.run({
    threadId: 'thread',
    runId: 'run',
    state: {},
    context: [],
    tools: [],
    messages: [{ id: 'user', role: 'user', content: '안녕하세요' }]
  })) {
    console.log(event)
  }
  const requests = (ctx.llm as MockLLMService).requests
  console.log(requests[0]?.input.messages)
} finally {
  await agent.dispose()
  await store.dispose()
  await llm.dispose()
}
```

`responses`를 지정하면 스트림 호출마다 다음 응답을 소비합니다. 빈 배열도 유효하며 첫 호출부터 실패합니다. 응답이 소진되면 자동 반복하거나 내장 시나리오로 대체하지 않고 오류를 던집니다. 토큰 계산과 모델 조회는 응답을 소비하지 않습니다. 스트림 순회를 시작하기 전에 취소된 호출도 응답을 소비하지 않습니다.

각 응답에는 다음 값을 지정합니다.

| 값        | 동작                                                                                    |
| --------- | --------------------------------------------------------------------------------------- |
| `text`    | 텍스트 시작·내용·종료 이벤트를 반환합니다. 빈 문자열도 허용합니다.                      |
| `events`  | 지정한 `LLMEvent` 배열을 순서대로 반환합니다. 도구 호출·사용량 등도 지정할 수 있습니다. |
| `error`   | 응답 이벤트를 전달한 뒤 이 메시지로 오류를 던집니다. 단독 지정도 가능합니다.            |
| `delayMs` | 각 이벤트와 오류 전에 기다립니다. 공통 `delayMs`보다 우선합니다.                        |

`text`와 `events`는 함께 지정할 수 없습니다. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`는 LLM이 아니라 실행 계층의 책임이므로 `events`에서 거부합니다. 입력과 이벤트는 복사하므로 테스트의 변경이 기록된 요청이나 다음 응답에 영향을 주지 않습니다.

`models`로 모델별 컨텍스트·출력 한도를 설정합니다. `inputTokens`가 없으면 입력 JSON의 UTF-8 바이트 수를 사용합니다. 이는 테스트용 추정값이며 실제 토크나이저가 아닙니다. `ExecutionOptions.signal`, 플러그인 해제와 스트림 `return()`은 대기 중인 응답도 중단합니다.

## 앱에서 사용하기

1. **설정 → LLM → 공급자 추가**에서 **Mock LLM**을 선택하고 저장합니다.
2. 모델 선택기에서 원하는 내장 시나리오를 선택합니다.
3. 대화를 보내 응답·실행 추적·저장·취소를 확인합니다.

| 모델         | 동작                                                                                    |
| ------------ | --------------------------------------------------------------------------------------- |
| `mock-text`  | 마지막 사용자 텍스트를 `Mock LLM:` 뒤에 붙여 스트리밍합니다.                            |
| `mock-tool`  | 사용자가 JSON으로 지정한 도구를 호출하고 후속 요청에서 도구 결과를 텍스트로 반환합니다. |
| `mock-error` | 공급자 오류를 발생시킵니다.                                                             |
| `mock-slow`  | 이벤트마다 150ms 기다립니다. 긴 입력을 보내면 생성 중 취소를 확인하기 쉽습니다.         |

도구 시나리오의 입력 예시입니다.

```json
{ "name": "weather", "arguments": { "location": "Seoul" } }
```

현재 요청에 등록된 도구만 호출합니다. 목업은 도구 실행 자체를 대체하지 않습니다. 지정한 도구는 실제로 실행되므로 네트워크 접근이나 파일 변경 같은 부작용이 있을 수 있습니다. 이름을 추측해 임의로 도구를 선택하지 않습니다.

`responses`를 생략하면 내장 시나리오를 반복 사용할 수 있습니다. 기본 한도는 컨텍스트 128,000, 출력 4,096이며 `listMockModels()`로 목록과 기능을 조회할 수 있습니다.

## Node.js 호스트

`KEUNDAL_PROVIDER=mock`으로 선택합니다. `KEUNDAL_MODEL`을 생략하면 `mock-text`를 사용하고 내장 모델 4개를 제공합니다. `KEUNDAL_CONTEXT_WINDOW`와 `KEUNDAL_MAX_OUTPUT_TOKENS`는 기존 호스트와 같은 방식으로 적용합니다. LLM용 API 키는 필요 없지만 호스트 HTTP 인증과 저장소 설정은 그대로 적용됩니다.

런타임 매니페스트의 `builtin:llm`에서도 `config.provider: "mock"` 또는 `export: "mock"`으로 선택할 수 있습니다. 테스트 응답을 고정하려면 해당 항목의 `config.responses`에 응답 배열을 지정하세요.
