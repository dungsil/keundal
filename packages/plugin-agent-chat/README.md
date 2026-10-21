# @keundal/plugin-agent-chat

`@keundal/agent-loop`의 공통 루프를 `ctx.agent`에 등록하는 대화 에이전트 플러그인입니다. `llm`, `session`, `generation`을 주입받습니다. 스킬과 요청 컨텍스트를 켜면 해당 서비스도 기다립니다.

```ts
import chatAgentPlugin from '@keundal/plugin-agent-chat'

await ctx.plugin(chatAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 4096,
  tools: []
})
```

설정과 확장 방법은 [공통 루프 문서](../agent-loop/README.md)를 참고합니다. 독립적인 에이전트 계약은 `@keundal/agent`, 실행 가능한 도구 계약은 `@keundal/tools`에서 가져옵니다.
