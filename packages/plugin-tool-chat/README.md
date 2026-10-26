# @keundal/plugin-tool-chat

채팅에서 사용하는 차트·날씨·Markdown 도구를 실행 가능한 `ExecutableTool[]`로 제공합니다. 도구 스키마와 화면의 결과 타입은 `@keundal/chat`에 남습니다.

```ts
import chatAgentPlugin from '@keundal/plugin-agent-chat'
import { createChatTools } from '@keundal/plugin-tool-chat'

await ctx.plugin(chatAgentPlugin, {
  model: 'your-model',
  maxOutputTokens: 1024,
  tools: createChatTools()
})
```

도구 선택은 앱의 조립부가 담당합니다.

일반 응답은 일반 텍스트로 표시합니다. 문서·표·코드 블록처럼 서식이 필요하면 `markdown` 도구에 `{ content: string }`을 전달합니다. UI는 완성된 입력을 정화한 뒤 Markdown으로 표시하며, 복사와 대화 내보내기에도 본문을 포함합니다. 본문을 도구 결과에 중복 저장하지 않도록 실행 결과는 `{ displayed: true }`만 반환합니다. 기존 도구와 같이 실행 후 모델을 다시 호출하므로, 모델에는 표시한 본문을 일반 응답에 반복하지 않도록 지시합니다.
