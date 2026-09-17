# @keundal/plugin-agent-simple

`llm`, `session`, `generation` 서비스를 조합하여 `ctx.agent.run()`을 제공합니다. 입력이 모델의 컨텍스트 예산을 넘으면 이전 대화를 축약합니다. 도구 실행 함수를 등록하면 도구 호출 수집, 실행, 결과 메시지 작성, 후속 생성을 자동으로 처리합니다.

## 도구 등록

LLM 플러그인과 저장소 플러그인을 등록한 `ctx`에 에이전트를 추가합니다.

```ts
import simpleAgentPlugin from '@keundal/plugin-agent-simple'

await ctx.plugin(simpleAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  maxToolRounds: 8,
  tools: [
    {
      name: 'lookup_product',
      description: 'Look up a product by its ID',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false
      },
      async execute(args, { signal }) {
        if (typeof args.id !== 'string') throw new Error('id must be a string')
        const response = await fetch(`https://example.com/products/${encodeURIComponent(args.id)}`, { signal })
        if (!response.ok) throw new Error(`product lookup failed: ${response.status}`)
        return JSON.stringify(await response.json())
      }
    }
  ]
})

for await (const event of ctx.agent.run({
  threadId: 'conversation-1',
  runId: 'run-1',
  state: {},
  messages: [{ id: 'question-1', role: 'user', content: '상품 A-123을 설명해 주세요.' }],
  tools: [],
  context: []
})) {
  console.log(event)
}
```

설정에 등록한 도구 정의는 모델 입력에 자동으로 추가합니다. `RunAgentInput.tools`에 같은 이름을 다시 넣으면 오류가 발생합니다. 실행 함수는 모델 요청이나 저장된 실행 기록에 포함하지 않습니다.

`execute`는 JSON 객체로 해석한 인자와 `threadId`, `runId`, `toolCallId`, `signal`을 받습니다. `parameters`는 모델에 전달할 JSON Schema입니다. 인자의 세부 타입과 업무 규칙은 실행 함수에서 검증해야 합니다. 반환값은 문자열이며, 객체 결과는 `JSON.stringify()`로 변환합니다.

## 대화 축약 설정

입력이 모델의 컨텍스트 예산을 넘으면 `@keundal/compaction`의 `compact()`를 자동으로 호출합니다. 별도 등록 없이 에이전트 설정의 `compaction`으로 축약 옵션을 조정합니다.

| 설정                 | 기본값 | 설명                                                                                                     |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `keepRecentMessages` | `6`    | 최근에 보존할 최소 메시지 수입니다. 사용자 턴과 도구 호출·결과를 분리하지 않도록 보존 범위를 확장합니다. |
| `maxSummaryTokens`   | `1024` | 요약 호출마다 허용하는 최대 출력 토큰 수입니다. 모델의 출력 한도 이내로 제한됩니다.                      |

세부 동작과 요약 과정은 [축약 문서](../compaction/README.md)를 참고합니다.

## 실행과 종료

- 모델 응답의 스트림이 끝나고 모든 도구 호출이 완료되면 호출 순서대로 실행합니다. 같은 응답에 잘못된 JSON, 미완료 호출, 미등록 도구가 있으면 실행을 시작하지 않습니다.
- 실행 결과는 `TOOL_CALL_RESULT` 이벤트와 `role: 'tool'` 메시지로 기록하며, 호출 ID로 원래 도구 호출과 연결합니다. 호출·결과·추론 서명을 포함한 대화를 후속 요청에 전달합니다.
- `maxToolRounds`는 도구를 실행하고 후속 생성을 요청하는 최대 횟수이며, 기본값은 8입니다. 한 응답에서 여러 도구를 호출해도 한 번으로 계산합니다. 한도에 도달한 뒤에도 최종 답변은 받을 수 있지만, 추가 도구 호출은 실행하지 않고 오류로 종료합니다.
- 후속 요청마다 입력 토큰을 다시 계산하고 필요하면 이전 대화를 축약합니다. 현재 사용자 턴의 도구 호출과 결과를 보존할 수 없으면 후속 생성을 시작하지 않습니다.
- 도구 실행 함수나 공급자가 실패하면 순회 중 예외로 전달합니다. 이미 기록한 호출과 결과는 실행 기록에 남기며, 성공한 세션 커밋은 수행하지 않습니다. 도구 오류를 모델이 처리하게 하려면 실행 함수가 오류 내용을 문자열로 반환하도록 구성합니다.
- 취소, 반복자 반환, 플러그인 해제는 실행 함수와 후속 생성에 취소 신호를 전달합니다. 실행 함수도 `signal`을 실제 작업에 연결해야 합니다.

전체 과정은 같은 `runId`를 사용하며, `RUN_STARTED`와 `RUN_FINISHED`는 각각 한 번만 전달합니다. 메모리·SQLite·IndexedDB 저장소는 최종 답변과 도구 결과를 함께 커밋한 뒤 `RUN_FINISHED`를 전달합니다. `generation.recover()`는 저장된 결과를 복구하며 도구나 모델을 다시 호출하지 않습니다. 외부 시스템에서 발생한 도구 부작용을 되돌리거나 정확히 한 번 실행하도록 보장하지는 않습니다.

실행 함수를 등록하지 않으면 기존 동작을 유지합니다. 이 경우 입력의 도구 정의와 호출 이벤트를 전달하고, 앱이 직접 결과를 처리합니다. 자동 실행을 사용하는 경우에는 모델이 호출할 도구의 실행 함수를 모두 등록해야 합니다.

## 사용자 정의 저장소

`GenerationService.run()`의 `GenerationOptions.stream`은 한 실행 안에서 사용할 이벤트 공급자입니다. 지정되면 기본 `llm.stream` 대신 호출하고, 저장소가 관리하는 취소 신호를 전달해야 합니다. 이벤트를 저장하고 최종 세션 커밋을 수행하는 책임은 계속 `generation`에 있습니다. 이 함수는 직렬화 대상인 `GenerationRequest`에 포함하지 않으며 복구 시 재실행하지 않습니다.
