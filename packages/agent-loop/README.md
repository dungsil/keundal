# @keundal/agent-loop

`@keundal/agent`의 계약을 구현하는 공통 실행 루프를 제공합니다. `AgentConfig`와 축약·도구 반복 정책은 이 패키지가 소유합니다. `llm`, `session`, `generation`을 조합하고 입력 예산 검사, 축약, 도구 실행과 후속 생성을 처리합니다.

플러그인 등록은 [`@keundal/plugin-agent-chat`](../plugin-agent-chat/README.md)과 [`@keundal/plugin-agent-coding`](../plugin-agent-coding/README.md)이 담당합니다. 이 패키지는 두 구현을 가져오지 않습니다. 공통 루프가 필요 없는 구현은 `@keundal/agent`의 `AgentService`를 직접 상속합니다.

## 구현 확장

`Agent`를 상속해 다른 에이전트 구현을 만듭니다. `systemPrompt()`은 매 실행에 앞서 모델에 전달할 시스템 지침을 정하고, `registerAgent()`는 구현 클래스를 `ctx.agent`로 등록합니다.

```ts
import { Agent, AgentConfigSchema, registerAgent, type AgentConfig } from '@keundal/agent-loop'
import type { Context } from 'cordis'

class ReviewAgent extends Agent {
  protected override systemPrompt(): string {
    return this.config.systemPrompt ?? 'Review the change and report the risk.'
  }
}

export const reviewAgentPlugin = Object.assign(
  function reviewAgentPlugin(ctx: Context, config: AgentConfig) {
    registerAgent(ctx, config, ReviewAgent)
  },
  { inject: ['llm', 'generation', 'session'], Config: AgentConfigSchema }
)
```

상속한 구현은 도구 실행, 후속 생성, 축약, 스킬 처리를 그대로 물려받습니다. 실행 흐름을 바꿔야 하면 `run()`을 덮어씁니다.

## 도구 등록

LLM 플러그인과 저장소 플러그인을 등록한 `ctx`에 에이전트를 추가합니다.

```ts
import agentPlugin from '@keundal/plugin-agent-chat'

await ctx.plugin(agentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  maxToolRounds: 8,
  maxToolCalls: 32,
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

### 도구 검색으로 원격 목록 지연 노출

`deferredToolProvider`에는 검색이 허용된 MCP 도구 공급자만 지정합니다. `deferredTools`를 설정하면 모델은 처음에 `search_tool`과 `tools`의 기존 도구만 봅니다. 이름이나 설명으로 검색한 도구의 스키마는 다음 요청에서만 추가합니다.

```ts
import { McpClient } from '@keundal/plugin-mcp-client'

const mcp = await McpClient.connect({
  serverName: 'documents',
  transport: 'stdio',
  command: 'node',
  args: ['/absolute/path/to/mcp-server.js'],
  permissions: { tools: ['search'] }
})
ctx.fiber.effect(() => () => mcp.close())

await ctx.plugin(agentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  tools: [],
  deferredTools: {
    maxSearchResults: 8,
    maxActiveTools: 16,
    maxSchemaBytes: 16_384,
    maxTotalSchemaBytes: 65_536
  },
  deferredToolProvider: (options) => mcp.tools(options)
})
```

한 실행에서 검색된 도구만 실행할 수 있습니다. 실행 직전에 공급자를 다시 조회하며, 현재 권한에서 사라졌거나 도구 정의가 바뀌면 실행을 거부합니다. 기본 한도는 검색 결과 8개, 활성 도구 16개, 도구 스키마 16 KiB, 전체 스키마 64 KiB입니다.

## 스킬 사용

`skills: true`를 설정하면 `skills` 서비스를 추가로 주입받습니다. 서비스가 사라지면 진행 중 실행을 취소하고, 서비스가 돌아오면 에이전트를 다시 구성합니다. 기본값은 비활성화이며 기존 세 서비스만 필요합니다.

```ts
import skillPlugin from '@keundal/plugin-skill'
import filesystemSkillPlugin from '@keundal/plugin-skill-filesystem'

await ctx.plugin(skillPlugin)
await ctx.plugin(filesystemSkillPlugin, { roots: ['./skills'] })
await ctx.plugin(agentPlugin, {
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

## 요청 컨텍스트

`context: true`를 설정하면 [`@keundal/context`](../context/README.md)의 `requestContext` 서비스를 주입받습니다. 공급자는 첫 모델 요청과 도구 후속 요청의 입력 예산 검사 전에 실행합니다.

공급자가 추가한 `user` 메시지는 `keundal.context.message` CUSTOM 이벤트로 실행 journal에 기록합니다. 세 저장소는 같은 코어 메시지 조립기를 사용하며, 성공한 실행에서 컨텍스트와 응답을 함께 커밋합니다.

`keundal:context:` 접두사는 컨텍스트 메시지의 예약 ID입니다. 호출자가 직접 입력에서 사용하면 거부합니다. 컨텍스트 서비스가 사라지면 진행 중 실행을 취소하며, 복구에서는 공급자를 다시 실행하지 않습니다.

## 시스템 지침

`systemPrompt`를 설정하면 매 실행의 맨 앞에 `system` 메시지로 지침을 넣습니다. 호출자가 입력 메시지에 넣는 시스템 메시지와 함께 전달되므로, 요청마다 다른 지침을 이어 붙일 수 있습니다.

지침 메시지의 예약 ID는 `keundal:system-prompt`입니다. 세션이 이전 지침을 반환하면 같은 ID의 현재 지침으로 대체하므로 지침이 쌓이지 않습니다. 호출자가 입력 메시지에 예약 ID를 사용하면 거부합니다.

지침은 축약에서 지시 메시지로 보존됩니다. 축약 요약에는 포함되지 않으므로 지침은 매 실행마다 그대로 유지됩니다.

## 대화 축약 설정

입력이 모델의 컨텍스트 예산에 가까워지면 `@keundal/compaction`의 `compact()`를 백그라운드에서 호출하여 축약을 준비합니다. 예산을 넘으면 준비 결과를 기다리거나 동기 축약을 수행합니다. 별도 등록 없이 에이전트 설정의 `compaction`으로 축약 옵션을 조정합니다.

| 설정                 | 기본값        | 설명                                                                                                         |
| -------------------- | ------------- | ------------------------------------------------------------------------------------------------------------ |
| `keepRecentMessages` | `6`           | 최근에 보존할 최소 메시지 수입니다. 사용자 턴과 도구 호출·결과를 분리하지 않도록 보존 범위를 확장합니다.     |
| `maxSummaryTokens`   | `1024`        | 요약 호출마다 허용하는 최대 출력 토큰 수입니다. 모델의 출력 한도 이내로 제한됩니다.                          |
| `keepRecentTokens`   | 지정하지 않음 | 최근 대화에 남길 최소 토큰 수입니다. 메시지 수 조건과 함께 적용하며 사용자 턴과 도구 호출·결과를 보존합니다. |
| `threshold`          | `0.8`         | 사용 가능한 입력 예산 중 백그라운드 준비를 시작하는 비율입니다. 0보다 크고 1 이하여야 합니다.                |
| `reserveTokens`      | `0`           | 출력 예산 외에 추가로 비워 둘 토큰 수입니다.                                                                 |
| `models`             | 지정하지 않음 | 모델 ID별 설정입니다. 지정한 값만 공통 설정을 재정의합니다.                                                  |

사용 가능한 입력 예산은 `contextWindow - maxOutputTokens - reserveTokens`입니다. 백그라운드 준비는 현재 생성을 기다리게 하지 않으며, 축약할 이전 사용자 턴이 있을 때만 시작합니다. 준비가 끝난 결과는 다음 입력 검사에서 적용합니다. `threshold: 1`은 입력 예산에 도달했을 때 준비를 시작합니다.

```ts
await ctx.plugin(agentPlugin, {
  model: 'your-model',
  maxOutputTokens: 4096,
  compaction: {
    threshold: 0.8,
    keepRecentMessages: 6,
    keepRecentTokens: 8000,
    reserveTokens: 2048,
    models: {
      'your-model': { threshold: 0.75, keepRecentTokens: 12000 }
    }
  }
})
```

준비 결과를 사용할 때는 원본 대화 메시지의 ID·내용·순서, 지침의 ID·내용, 도구·컨텍스트 등 요청 메타데이터를 검사합니다. 요청의 `state`는 항상 최신 입력에서 유지합니다. 원본 뒤에 추가된 메시지는 보존하며, 원본이 수정되거나 순서가 바뀌면 결과를 폐기합니다. 적용 전에는 최신 입력 전체의 토큰 수를 다시 검사합니다. 준비 결과는 에이전트 메모리에 스레드별 하나씩, 최대 32개까지 보관하며 세션을 직접 변경하지 않습니다.

준비 실패는 정상 생성을 중단하지 않습니다. 실행 취소와 반복자 반환은 해당 실행의 준비도 취소합니다. 정상 종료한 실행의 준비는 다음 요청을 위해 계속 진행하며, 플러그인을 해제하면 모두 취소합니다.

공급자가 실제 컨텍스트 초과를 알리면 예상 토큰 수가 예산 이내여도 축약 후 한 번 재시도합니다. 각 모델 요청에서 응답 이벤트를 전달하기 전에만 재시도하며, 부분 응답 전달 후의 오류와 인증·요청 제한 등 다른 오류는 그대로 전달합니다. 도구 후속 요청에도 같은 정책을 적용하며 이미 완료된 도구는 다시 실행하지 않습니다. 재시도는 같은 generation 안에서 수행하고 `generation.recover()`에서는 수행하지 않습니다. generation 요청에는 최초 입력의 축약 정보가 기록됩니다.

세부 동작과 요약 과정은 [축약 문서](../compaction/README.md)를 참고합니다.

## 실행 추적과 모델 사용량

`Agent`는 `keundal.trace` CUSTOM 이벤트에 버전 1 추적 span을 기록합니다. Span은 실행, 모델 요청, 실제 도구 실행, 축약을 연결합니다. Span은 시작 순서를 보존합니다.

오류에는 안전한 범주만 기록합니다. 도구 인자와 결과는 기록하지 않습니다. 공급자의 원문 오류도 기록하지 않습니다.

실행 종료 때 계속 진행 중인 백그라운드 축약 Span에는 `detached: true`를 표시하고 마지막 관측 상태를 유지합니다. 실제 종료 시각을 만들지 않으며 실행 성공 여부는 generation의 최종 상태로 판단합니다.

OpenAI, Anthropic, Gemini 공급자는 확인한 토큰 사용량을 `keundal.llm.usage` 이벤트로 전달합니다. 확인한 캐시 토큰도 별도 필드로 기록합니다. 명시된 가격 정보가 없으면 비용을 계산하지 않습니다. 누락된 사용량은 알 수 없는 값으로 유지합니다. 집계기는 모델 Span만 합산하며 실행과 축약 Span의 토큰은 다시 더하지 않습니다.

## 지연 도구

`deferredTools`를 설정하면 `deferredToolProvider`도 설정합니다. 에이전트는 실행마다 검색 도구만 먼저 노출합니다. 검색 결과에는 도구 이름과 설명만 포함합니다. 선택한 도구 스키마는 다음 모델 요청에 노출합니다.

기존 `tools` 설정은 첫 요청에 계속 노출됩니다. 에이전트는 요청마다 지연 도구 카탈로그를 다시 확인합니다. 검색한 도구만 실행할 수 있습니다. `deferredTools`로 검색 결과 수, 선택 가능한 도구 수, 스키마 크기를 제한합니다.

## 실행과 종료

- `AgentConfig.webSearch?: boolean`과 `reasoning?: boolean | 'low' | 'medium' | 'high'`은 입력 토큰 계산, generation 요청, 모든 도구 후속 요청에 그대로 전달됩니다. 생략하면 기존 공급자 기본값을 유지하며 정의되지 않은 추론 수준은 거부합니다. 축약 후에도 이 옵션을 포함한 입력 비용을 다시 확인합니다. 요약 자체는 검색 도구 없이 수행합니다.
- `AgentConfig.pricing?: { currency, models }`는 모델 ID별 100만 토큰당 가격입니다. 공급자가 비용을 주지 않은 모델 호출에 `source: 'estimate'` 비용을 기록하고, 공급자 비용은 덮어쓰지 않습니다. 본 응답, 축약 호출, 서브에이전트가 같은 경로를 사용합니다. 가격이 없거나 사용량이 모자라면 비용을 미확정으로 둡니다. 형식과 계산식은 [실행 관측 문서](../../docs/execution-trace.md#모델-가격표)를 참고합니다.
- OpenAI·Anthropic 네이티브 검색은 공급자에서 수행하므로 `tools`에 검색 실행 함수를 등록하지 않습니다. 검색 출처는 코어의 `LLM_SOURCE_EVENT`(`'keundal.source'`) CUSTOM 이벤트로 전달됩니다. 검색·인용의 공급자 메타데이터는 어시스턴트 메시지와 함께 후속 요청·세션에 보존됩니다. 자세한 메타데이터 형식과 모델 지원 제한은 각 공급자의 README를 참고합니다. Gemini는 `webSearch: true`를 명시적으로 거부합니다.
- 모델 응답의 스트림이 끝나고 모든 도구 호출이 완료되면 호출 순서대로 실행합니다. 같은 응답에 잘못된 JSON, 미완료 호출, 미등록 도구가 있으면 실행을 시작하지 않습니다.
- 실행 결과는 `TOOL_CALL_RESULT` 이벤트와 `role: 'tool'` 메시지로 기록하며, 호출 ID로 원래 도구 호출과 연결합니다. 호출·결과·추론 서명을 포함한 대화를 후속 요청에 전달합니다.
- `maxToolRounds`는 도구를 실행하고 후속 생성을 요청하는 최대 횟수이며, 기본값은 8입니다. 한 응답에서 여러 도구를 호출해도 한 번으로 계산합니다. 한도에 도달한 뒤에도 최종 답변은 받을 수 있지만, 추가 도구 호출은 실행하지 않고 오류로 종료합니다.
- `maxToolCalls`는 한 실행의 모든 응답에서 허용할 도구 호출의 총개수이며, 기본값은 32입니다. 한도를 넘는 호출을 수신하면 즉시 스트림을 종료하고 해당 응답의 도구는 하나도 실행하지 않습니다. 이전 응답에서 완료한 결과는 보존하며, 한도에 도달한 뒤에도 도구 호출이 없는 최종 답변은 받을 수 있습니다. 양의 안전한 정수로 설정합니다.
- `parallelTools`를 켜면 같은 응답의 도구 실행을 겹쳐 시작해 라운드 지연을 줄입니다. 결과 이벤트는 호출 순서대로 전달되며, 순서가 되기 전에 실패한 실행이 있으면 그 오류를 전달하고 아직 전달하지 않은 나머지 실행의 결과는 기록하지 않습니다. 기본값은 false로 순차 실행이며, 실패 시 이후 도구는 시작하지 않습니다.
- 후속 요청마다 입력 토큰을 다시 계산하고 필요하면 이전 대화를 축약합니다. 현재 사용자 턴의 도구 호출과 결과를 보존할 수 없으면 후속 생성을 시작하지 않습니다.
- 도구 실행 함수나 공급자가 실패하면 순회 중 예외로 전달합니다. 이미 기록한 호출과 결과는 실행 기록에 남기며, 성공한 세션 커밋은 수행하지 않습니다. 도구 오류를 모델이 처리하게 하려면 실행 함수가 오류 내용을 문자열로 반환하도록 구성합니다.
- 취소, 반복자 반환, 플러그인 해제는 실행 함수와 후속 생성에 취소 신호를 전달합니다. 실행 함수도 `signal`을 실제 작업에 연결해야 합니다.
- `run(input, { steer })`에 `SteerQueue`를 넘기면 실행 중에 사용자 지시를 받습니다. 진행 중인 모델 요청과 도구는 중단하지 않습니다. 도구 결과를 기록한 뒤나 도구 호출이 없는 응답 뒤에 지시를 꺼내 다음 요청의 사용자 메시지로 넣습니다. 지시는 `STEER_MESSAGE_EVENT` CUSTOM 이벤트로 journal에 남고, 다음 요청에는 같은 입력 예산 검사와 축약을 적용합니다. 도구를 등록하지 않았거나 `maxToolRounds`에 도달하면 지시를 꺼내지 않습니다. 자세한 규칙은 [실행 제어 문서](../../docs/run-control.md)를 참고합니다.

전체 과정은 같은 `runId`를 사용하며, `RUN_STARTED`와 `RUN_FINISHED`는 각각 한 번만 전달합니다. 메모리·SQLite·IndexedDB 저장소는 최종 답변과 도구 결과를 함께 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 다만 SQLite·IndexedDB에서 실행이 임차 만료 등으로 다른 프로세스나 탭에 회수되어 종료가 확정되면 이 실행의 종료는 적용되지 않고, `RUN_FINISHED` 없이 순회가 끝납니다. `generation.recover()`는 저장된 결과를 복구하며 도구나 모델을 다시 호출하지 않습니다. 외부 시스템에서 발생한 도구 부작용을 되돌리거나 정확히 한 번 실행하도록 보장하지는 않습니다.

실행 함수를 등록하지 않으면 기존 동작을 유지합니다. 이 경우 입력의 도구 정의와 호출 이벤트를 전달하고, 앱이 직접 결과를 처리합니다. 자동 실행을 사용하는 경우에는 모델이 호출할 도구의 실행 함수를 모두 등록해야 합니다.

## 사용자 정의 저장소

`GenerationService.run()`의 `GenerationOptions.stream`은 한 실행 안에서 사용할 이벤트 공급자입니다. 지정되면 기본 `llm.stream` 대신 호출하고, 저장소가 관리하는 취소 신호를 전달해야 합니다. 이벤트를 저장하고 최종 세션 커밋을 수행하는 책임은 계속 `generation`에 있습니다. 이 함수는 직렬화 대상인 `GenerationRequest`에 포함하지 않으며 복구 시 재실행하지 않습니다.

## 서브에이전트

`subagents: true`를 설정하면 모델에 `delegate_task` 도구를 제공합니다. 기본값은 비활성화입니다.
모델은 `{ "task": "작업 지침과 필요한 문맥", "label": "작업 이름" }`으로 위임합니다.
`label`은 선택 사항이며 1~80자의 이름을 상태 표시와 자식 기록에 사용합니다.

`subagentRoles`로 역할의 `name`, `description`, `instructions`를 정의합니다.
모델에는 이름과 설명만 도구 정의로 제공하며, `delegate_task`의 선택 인자 `role`로 역할을 고르면
해당 지침을 서브에이전트의 시스템 메시지에 추가합니다. `role`을 생략하면 기존 일반 위임을 유지합니다.
등록하지 않은 역할은 실행 전에 거부합니다. `label`을 생략하면 역할 이름을 진행 상태에 표시합니다.

```ts
subagentRoles: [
  {
    name: 'reviewer',
    description: 'Review code changes for correctness.',
    instructions: 'Check the supplied diff for bugs and missing tests. Report concrete risks.'
  }
]
// delegate_task({ task: 'Review this diff: ...', role: 'reviewer' })
```

이름은 영문자·숫자·밑줄·하이픈으로 1~64자이며 대소문자를 구분하고 중복할 수 없습니다.
설명은 1~500자, 지침은 1~20,000자이며 역할은 최대 32개입니다. 앞뒤 공백은 제거합니다.
`RunAgentInput.state.subagentRoles`를 전달하면 해당 실행에서는 설정의 목록 대신 사용합니다.
빈 배열은 설정의 역할도 제공하지 않습니다. 실행이 시작된 뒤에는 역할 목록이 바뀌지 않습니다.

자식은 같은 모델, 시스템 지침, 등록된 도구, 스킬과 축약 정책을 사용합니다.
부모의 대화 기록, 요청 도구, 상태와 문맥은 복사하지 않으므로 필요한 정보는 `task`에 넣어야 합니다.
자식의 대화와 실행 기록은 별도 ID로 저장하며, 상태의 `subagent`에 부모의 `threadId`, `runId`와
위임한 `toolCallId`를 기록합니다. 부모에게는 자식의 응답 스트림 대신 실행 상태와 도구 결과를 전달합니다.
실행 상태는 `keundal.tool.progress` 사용자 지정 이벤트로 전달하며, 병렬 작업도 완료되는 즉시 상태를 알립니다.

자식은 다시 위임할 수 없습니다. 부모와 자식 각각에 기존 `maxToolRounds`와 `maxToolCalls` 제한을
적용합니다. `parallelTools: true`이면 같은 응답에서 요청한 여러 위임도 병렬로 실행합니다.
`maxActiveSubagents`는 부모 실행 하나에서 동시에 실행할 자식 수를 제한하며 기본값은 8입니다.
준비를 시작하기 전에 자리를 확보하고 정리가 끝나면 반환합니다. 한도를 넘는 요청은 대기열에 넣지 않고
`ACTIVE_LIMIT_REACHED` 오류를 결과로 반환하므로, 부모는 다음 도구 실행 차례에 다시 요청할 수 있습니다.

도구 결과는 다음과 같은 JSON 문자열입니다.

- 성공: `{ status: "completed", threadId, runId, content }`
- 자식 실행 실패: `{ status: "failed", threadId, runId, content, error: { code, message } }`
- 한도 초과: `{ status: "rejected", error: { code: "ACTIVE_LIMIT_REACHED", message } }`

`content`는 마지막 비어 있지 않은 어시스턴트 답변입니다. 실패 결과에는 부분 응답이 포함될 수 있지만
성공을 뜻하지 않습니다. 자식 하나가 실패해도 형제와 부모는 계속 실행하며, 부모 모델이 결과를 보고
후속 작업을 결정합니다. 부모 취소, 순회 중단 또는 플러그인 해제는 자식 실행도 중단합니다.
취소는 복구 가능한 도구 결과로 변환하지 않습니다.

설계 참고 자료와 적용 범위는 [서브에이전트 위임 결정](../../docs/adr/0003-subagent-delegation.md)에 기록했습니다.
