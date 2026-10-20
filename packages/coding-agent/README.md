# @keundal/coding-agent

`@keundal/agent`의 에이전트 구현 계약을 확장한 코딩 작업용 에이전트입니다. 기본 코딩 지침을 모든 실행에 앞서 모델에 전달합니다. 파일 편집과 명령 실행 도구는 앱이 조합합니다.

## 사용

```ts
import codingAgentPlugin from '@keundal/coding-agent'

await ctx.plugin(codingAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 8192
})

for await (const event of ctx.agent.run({
  threadId: 'conversation-1',
  runId: 'run-1',
  state: {},
  messages: [{ id: 'question-1', role: 'user', content: '로그 파싱 함수를 고쳐 주세요.' }],
  tools: [],
  context: []
})) {
  console.log(event)
}
```

`llm`, `session`, `generation` 서비스를 조합하고, 입력이 모델의 컨텍스트 예산을 넘으면 이전 대화를 축약합니다. 도구 실행 함수를 등록하면 도구 호출 수집, 실행, 결과 메시지 작성, 후속 생성을 자동으로 처리합니다. 자세한 실행 규칙은 [에이전트 문서](../agent/README.md)를 참고합니다.

`CodingAgent` 클래스는 `Agent`를 상속합니다. 다른 에이전트 구현을 만들 때 같은 방법을 따릅니다.

## 시스템 지침

코딩 에이전트는 기본 지침을 `system` 메시지로 매 실행의 맨 앞에 넣습니다. 지침은 파일을 먼저 읽고, 최소한으로 고치고, 저장소의 규칙과 검사를 따르며, 되돌리기 어려운 작업은 먼저 확인하도록 요구합니다.

`systemPrompt`를 설정하면 기본 지침을 대체합니다. 요청마다 다른 지침을 이어 붙이려면 호출자가 입력 메시지에 `system` 메시지를 넣으면 됩니다.

```ts
await ctx.plugin(codingAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 8192,
  systemPrompt: '저장소의 TypeScript 규칙만 지켜 주세요.'
})
```

지침은 예약 ID `keundal:system-prompt`을 사용합니다. 세션이 이전 지침을 반환하면 같은 ID의 현재 지침으로 대체하므로 지침이 쌓이지 않습니다. 호출자가 입력 메시지에 예약 ID를 사용하면 거부합니다.

## 파일과 셸 도구

코딩 에이전트는 도구를 직접 등록하지 않습니다. 앱이 [`@keundal/plugin-tool-fs`](../plugin-tool-fs/README.md)와 [`@keundal/plugin-tool-shell`](../plugin-tool-shell/README.md)의 서비스를 조합해 전달합니다.

```ts
import codingAgentPlugin from '@keundal/coding-agent'
import fileSystemToolsPlugin from '@keundal/plugin-tool-fs'
import shellToolsPlugin from '@keundal/plugin-tool-shell'

await ctx.plugin(fileSystemToolsPlugin)
await ctx.plugin(shellToolsPlugin)
await ctx.plugin({
  inject: ['fsTools', 'shellTools'],
  apply(ctx) {
    ctx.plugin(codingAgentPlugin, {
      model: 'your-model',
      maxOutputTokens: 8192,
      tools: [...ctx.fsTools.tools, ...ctx.shellTools.tools]
    })
  }
})
```

도구 공급자를 사용하면 실행마다 도구 목록을 다시 고를 수 있습니다. 외부 MCP 서버의 도구는 [`@keundal/mcp`](../mcp/README.md)를 참고합니다.

## 설정

| 설정              | 기본값    | 설명                                                                   |
| ----------------- | --------- | ---------------------------------------------------------------------- |
| `model`           | 없음      | 사용할 모델 이름입니다. 필수입니다.                                    |
| `maxOutputTokens` | 없음      | 모델의 출력 예산입니다. 양의 정수여야 하며 필수입니다.                 |
| `systemPrompt`    | 코딩 지침 | 기본 코딩 지침을 대체하는 시스템 지침입니다.                           |
| `tools`           | 없음      | 실행 가능한 도구 목록 또는 실행마다 목록을 고르는 공급자입니다.        |
| `skills`          | `false`   | `skills` 서비스를 주입받아 스킬 목록과 본문을 제공합니다.              |
| `compaction`      | 없음      | 축약 옵션입니다. `keepRecentMessages`와 `maxSummaryTokens`를 받습니다. |
| `webSearch`       | 없음      | 공급자의 네이티브 검색을 켭니다.                                       |
| `reasoning`       | 없음      | 공급자의 추론 기능을 켭니다.                                           |
| `maxToolRounds`   | `8`       | 도구를 실행하고 후속 생성을 요청하는 최대 횟수입니다.                  |
| `parallelTools`   | `false`   | 같은 응답의 도구 실행을 겹쳐 시작합니다.                               |

## 안전

셸 도구와 파일 도구는 샌드박스가 아닙니다. 파일 정책은 경로·수정 권한만 검사하고, 셸 명령은 파일 정책을 거치지 않습니다. 신뢰할 수 없는 모델의 명령에는 OS 격리와 권한 제한을 적용하십시오.
