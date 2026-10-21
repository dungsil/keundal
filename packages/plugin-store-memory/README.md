# @keundal/plugin-store-memory

`ctx.session`과 `ctx.generation`을 하나의 `MemoryStore`로 제공합니다. `generation`은 `llm` 서비스가 등록되면 사용할 수 있습니다. `store`를 생략하면 플러그인 등록마다 새 저장소를 만듭니다. LLM을 교체하면 실행 중인 생성을 취소하고 `generation`을 다시 구성하며, `session`과 저장소에 보관한 journal은 유지합니다. 플러그인 자체를 해제하고 다시 등록할 때도 상태를 유지하려면 `store`를 전달합니다.

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
- `commit()`은 기본적으로 메시지를 병합합니다. `mode: 'replace'`는 전체 메시지를 교체하며 `messages: []`로 모두 비울 수 있습니다. revision 검사와 종료 기록의 중복 적용 방지는 그대로 유지됩니다.
- `delete(threadId, expectedRevision, { signal }?)`는 현재 revision(없는 스레드는 0)을 검사하고 스레드와 모든 실행·journal을 함께 삭제합니다. 빈 threadId와 음수·안전하지 않은 정수 revision은 거부합니다. `running` 실행이 있으면 삭제를 거부하며 자동 취소하지 않으므로 호출자가 먼저 실행을 중단하고 종료 확정을 기다려야 합니다. 없는 스레드의 revision 0 삭제는 반복할 수 있습니다.
- 삭제는 낙관적 동시성 검사이며 영구 tombstone을 남기지 않습니다. 이미 준비한 입력과 새 동시 실행에는 기존 generation·revision 계약이 적용되며, 이후 스레드가 다시 생성될 수 있습니다.
- 성공한 실행은 메시지·journal·종료 상태를 함께 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 실패·취소·중단 시 부분 응답은 실행 기록에만 남고 대화와 상태는 바뀌지 않습니다.
- 외부 `AbortSignal` 취소는 실행을 `cancelled`로 확정합니다. 순회 중단과 서비스 해제 시 실행은 `interrupted`로 남습니다. 같은 저장소로 서비스를 재등록한 뒤 `recover()`로 복구할 수 있으며, LLM을 다시 호출하지 않습니다.

프로세스가 종료되면 저장 내용이 사라집니다. 여러 프로세스가 공유하는 저장소나 프로세스 재시작 후 복구가 필요하면 [`@keundal/plugin-store-sqlite`](../plugin-store-sqlite/README.md)를 사용합니다.
