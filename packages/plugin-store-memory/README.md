# `@keundal/plugin-store-memory`

`MemoryStore`는 `session`과 `generation` 상태를 프로세스 메모리에 저장하는 구현입니다.

실행 중 외부 `AbortSignal`이 취소하면 실행을 `cancelled`로 확정하고 부분 journal과 메시지를 보존합니다. 소비자가 순회를 중단하거나 서비스가 해제되면 실행은 `interrupted`로 남으며, 같은 `MemoryStore`를 사용해 서비스를 다시 등록한 뒤 `ctx.generation.recover()`를 호출하면 복구할 수 있습니다. 복구는 LLM을 다시 호출하지 않습니다.

이 구현은 프로세스가 종료되면 저장 내용이 사라집니다. SQLite를 포함한 프로세스 간 영속 저장과 재시작 복구는 지원 범위에 포함되지 않습니다.

```ts
const store = new MemoryStore()
const fiber = await ctx.plugin(memoryStorePlugin, { store })
await fiber.dispose()
await ctx.plugin(memoryStorePlugin, { store })
const recovered = await ctx.generation.recover()
```
