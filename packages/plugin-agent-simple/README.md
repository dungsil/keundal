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

`tools`에는 배열 대신 `(options: ExecutionOptions) => ExecutableTool[] | Promise<ExecutableTool[]>` 공급자를 지정할 수 있습니다. 공급자는 실행 시작마다 취소 신호를 받으며, 반환한 도구 목록은 해당 실행의 후속 생성까지 고정합니다. 조회 실패나 중복 이름은 생성을 시작하기 전에 거부합니다. 외부 MCP 서버 연결은 [`@keundal/mcp`](../mcp/README.md)를 참고합니다.

## 스킬 사용

`skills: true`를 설정하면 `skills` 서비스를 추가로 주입받습니다. 서비스가 사라지면 진행 중 실행을 취소하고, 서비스가 돌아오면 에이전트를 다시 구성합니다. 기본값은 비활성화이며 기존 세 서비스만 필요합니다.

```ts
import skillPlugin from '@keundal/plugin-skill'
import filesystemSkillPlugin from '@keundal/plugin-skill-filesystem'

await ctx.plugin(skillPlugin)
await ctx.plugin(filesystemSkillPlugin, { roots: ['./skills'] })
await ctx.plugin(simpleAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  skills: true
})
```

매 실행에서 이름과 설명 목록을 준비한 뒤 `system` 메시지로 추가합니다. 설명의 공백을 정규화하고 스킬당 최대 500자로 제한합니다. 본문은 목록에 포함하지 않습니다.

모델은 `skill({ name })` 도구로 본문을 불러옵니다. 로딩은 스크립트나 첨부 파일을 실행하거나 읽지 않습니다. 선택한 공급자는 실행 중 유지하지만, 파일 본문은 로딩 시점의 내용을 사용할 수 있습니다.

목록과 본문은 입력 토큰 예산에 포함합니다. 본문은 일반 도구 결과로 기록하며 후속 요청의 예산 검사를 거칩니다. 본문을 임의로 자르지 않으며, 축약 후에도 입력을 보존할 수 없으면 후속 생성을 시작하지 않습니다.

목록 메시지의 예약 ID는 `keundal:skill-catalog`입니다. 세션이 이전 목록을 반환하면 같은 ID의 현재 목록으로 대체합니다. 목록이 비거나 스킬을 끄면 이전 안내를 무효화하며, 목록을 쌓지 않습니다. 호출자가 입력 메시지에 예약 ID를 사용하면 거부합니다.

기본 저장소는 목록을 별도 세션 기록으로 저장하지 않습니다. 목록은 생성 요청에 포함되며 매 실행마다 새로 준비합니다. 불러온 본문은 기존 도구 결과와 같은 저장·축약 정책을 따릅니다. 복구 시 스킬을 다시 읽지 않습니다.

스킬 사용 시 `skill`이라는 이름의 도구를 설정이나 입력에 중복 등록할 수 없습니다. 없는 이름과 잘못된 인자는 도구 결과로 안내합니다. 파일 오류는 실행 오류로, 취소는 취소로 전달합니다.

`/name` 직접 호출, 파일 감시, 리소스 자동 로딩은 지원하지 않습니다.

## 대화 축약 설정

입력이 모델의 컨텍스트 예산을 넘으면 `@keundal/compaction`의 `compact()`를 자동으로 호출합니다. 별도 등록 없이 에이전트 설정의 `compaction`으로 축약 옵션을 조정합니다.

| 설정                 | 기본값 | 설명                                                                                                     |
| -------------------- | ------ | -------------------------------------------------------------------------------------------------------- |
| `keepRecentMessages` | `6`    | 최근에 보존할 최소 메시지 수입니다. 사용자 턴과 도구 호출·결과를 분리하지 않도록 보존 범위를 확장합니다. |
| `maxSummaryTokens`   | `1024` | 요약 호출마다 허용하는 최대 출력 토큰 수입니다. 모델의 출력 한도 이내로 제한됩니다.                      |

세부 동작과 요약 과정은 [축약 문서](../compaction/README.md)를 참고합니다.

## 실행과 종료

- `SimpleAgentConfig.webSearch?: boolean`과 `reasoning?: boolean`은 입력 토큰 계산, generation 요청, 모든 도구 후속 요청에 그대로 전달됩니다. 생략하면 기존 공급자 기본값을 유지하며 boolean이 아닌 값은 거부합니다. 축약 후에도 이 옵션을 포함한 입력 비용을 다시 확인합니다. 요약 자체는 검색 도구 없이 수행합니다.
- OpenAI·Anthropic 네이티브 검색은 공급자에서 수행하므로 `tools`에 검색 실행 함수를 등록하지 않습니다. 검색 출처는 코어의 `LLM_SOURCE_EVENT`(`'keundal.source'`) CUSTOM 이벤트로 전달됩니다. 검색·인용의 공급자 메타데이터는 어시스턴트 메시지와 함께 후속 요청·세션에 보존됩니다. 자세한 메타데이터 형식과 모델 지원 제한은 각 공급자의 README를 참고합니다. Gemini는 `webSearch: true`를 명시적으로 거부합니다.
- 모델 응답의 스트림이 끝나고 모든 도구 호출이 완료되면 호출 순서대로 실행합니다. 같은 응답에 잘못된 JSON, 미완료 호출, 미등록 도구가 있으면 실행을 시작하지 않습니다.
- 실행 결과는 `TOOL_CALL_RESULT` 이벤트와 `role: 'tool'` 메시지로 기록하며, 호출 ID로 원래 도구 호출과 연결합니다. 호출·결과·추론 서명을 포함한 대화를 후속 요청에 전달합니다.
- `maxToolRounds`는 도구를 실행하고 후속 생성을 요청하는 최대 횟수이며, 기본값은 8입니다. 한 응답에서 여러 도구를 호출해도 한 번으로 계산합니다. 한도에 도달한 뒤에도 최종 답변은 받을 수 있지만, 추가 도구 호출은 실행하지 않고 오류로 종료합니다.
- `parallelTools`를 켜면 같은 응답의 도구 실행을 겹쳐 시작해 라운드 지연을 줄입니다. 결과 이벤트는 호출 순서대로 전달되며, 순서가 되기 전에 실패한 실행이 있으면 그 오류를 전달하고 아직 전달하지 않은 나머지 실행의 결과는 기록하지 않습니다. 기본값은 false로 순차 실행이며, 실패 시 이후 도구는 시작하지 않습니다.
- 후속 요청마다 입력 토큰을 다시 계산하고 필요하면 이전 대화를 축약합니다. 현재 사용자 턴의 도구 호출과 결과를 보존할 수 없으면 후속 생성을 시작하지 않습니다.
- 도구 실행 함수나 공급자가 실패하면 순회 중 예외로 전달합니다. 이미 기록한 호출과 결과는 실행 기록에 남기며, 성공한 세션 커밋은 수행하지 않습니다. 도구 오류를 모델이 처리하게 하려면 실행 함수가 오류 내용을 문자열로 반환하도록 구성합니다.
- 취소, 반복자 반환, 플러그인 해제는 실행 함수와 후속 생성에 취소 신호를 전달합니다. 실행 함수도 `signal`을 실제 작업에 연결해야 합니다.

전체 과정은 같은 `runId`를 사용하며, `RUN_STARTED`와 `RUN_FINISHED`는 각각 한 번만 전달합니다. 메모리·SQLite·IndexedDB 저장소는 최종 답변과 도구 결과를 함께 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 다만 SQLite·IndexedDB에서 실행이 임차 만료 등으로 다른 프로세스나 탭에 회수되어 종료가 확정되면 이 실행의 종료는 적용되지 않고, `RUN_FINISHED` 없이 순회가 끝납니다. `generation.recover()`는 저장된 결과를 복구하며 도구나 모델을 다시 호출하지 않습니다. 외부 시스템에서 발생한 도구 부작용을 되돌리거나 정확히 한 번 실행하도록 보장하지는 않습니다.

실행 함수를 등록하지 않으면 기존 동작을 유지합니다. 이 경우 입력의 도구 정의와 호출 이벤트를 전달하고, 앱이 직접 결과를 처리합니다. 자동 실행을 사용하는 경우에는 모델이 호출할 도구의 실행 함수를 모두 등록해야 합니다.

## 사용자 정의 저장소

`GenerationService.run()`의 `GenerationOptions.stream`은 한 실행 안에서 사용할 이벤트 공급자입니다. 지정되면 기본 `llm.stream` 대신 호출하고, 저장소가 관리하는 취소 신호를 전달해야 합니다. 이벤트를 저장하고 최종 세션 커밋을 수행하는 책임은 계속 `generation`에 있습니다. 이 함수는 직렬화 대상인 `GenerationRequest`에 포함하지 않으며 복구 시 재실행하지 않습니다.
