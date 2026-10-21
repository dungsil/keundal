# @keundal/plugin-tool-chat

채팅에서 사용하는 차트·날씨 도구를 실행 가능한 `ExecutableTool[]`로 제공합니다. 도구 스키마와 화면의 결과 타입은 `@keundal/chat`에 남습니다.

```ts
import chatAgentPlugin from '@keundal/plugin-agent-chat'
import { createChatTools } from '@keundal/plugin-tool-chat'

await ctx.plugin(chatAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  tools: createChatTools()
})
```

도구 선택은 앱의 조립부가 담당합니다. 이전 `@keundal/chat/tools/agent` 대신 이 패키지를 사용합니다.
