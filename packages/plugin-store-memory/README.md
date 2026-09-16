# @keundal/plugin-store-memory

`ctx.session`과 `ctx.generation`을 하나의 `MemoryStore`로 제공합니다. `llm` 서비스를 등록한 뒤 사용합니다. `store`를 생략하면 등록할 때 새 저장소를 만듭니다.

```ts
import memoryStorePlugin, { MemoryStore } from '@keundal/plugin-store-memory'

const store = new MemoryStore()
const fiber = await ctx.plugin(memoryStorePlugin, { store })

// 같은 저장소로 서비스를 재등록한 뒤 남은 실행을 복구합니다.
await fiber.dispose()
await ctx.plugin(memoryStorePlugin, { store })
const recovered = await ctx.generation.recover()
```

- `prepare()`는 저장된 대화에 요청 메시지를 병합하며, 같은 ID가 있으면 요청 메시지로 대체합니다.
- 성공한 실행은 메시지·journal·종료 상태를 함께 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 실패·취소·중단 시 부분 응답은 실행 기록에만 남고 대화와 상태는 바뀌지 않습니다.
- 외부 `AbortSignal` 취소는 실행을 `cancelled`로 확정합니다. 순회 중단과 서비스 해제 시 실행은 `interrupted`로 남습니다. 같은 저장소로 서비스를 재등록한 뒤 `recover()`로 복구할 수 있으며, LLM을 다시 호출하지 않습니다.

프로세스가 종료되면 저장 내용이 사라집니다. 여러 프로세스가 공유하는 저장소나 프로세스 재시작 후 복구가 필요하면 별도의 영속 저장소 구현을 사용해야 합니다.
