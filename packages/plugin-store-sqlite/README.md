# `@keundal/plugin-store-sqlite`

`ctx.session`과 `ctx.generation`을 하나의 SQLite 파일에 저장합니다. Node.js 내장 `node:sqlite`를 사용하므로 별도 의존성이 필요 없습니다. `llm` 서비스를 등록한 뒤 사용합니다.

```ts
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'

const fiber = await ctx.plugin(sqliteStorePlugin, { path: 'keundal.sqlite' })

// 같은 경로로 서비스를 재등록한 뒤 남은 실행을 복구합니다.
await fiber.dispose()
await ctx.plugin(sqliteStorePlugin, { path: 'keundal.sqlite' })
const recovered = await ctx.generation.recover()
```

`path`에는 데이터베이스 파일 경로를 지정합니다. 파일이 없으면 새로 만들고, 등록할 때 필요한 테이블을 준비합니다. `:memory:`를 전달하면 프로세스 메모리에만 저장합니다.

- `prepare()`는 저장된 대화에 요청 메시지를 병합하며, 같은 ID가 있으면 요청 메시지로 대체합니다.
- `commit()`은 기본적으로 메시지를 병합합니다. `mode: 'replace'`는 전체 메시지를 교체하며 `messages: []`로 모두 비울 수 있습니다. revision 검사와 종료 기록의 중복 적용 방지는 그대로 유지됩니다.
- `delete(threadId, expectedRevision, { signal }?)`는 현재 revision(없는 스레드는 0)을 검사하고 스레드와 모든 실행·journal을 하나의 트랜잭션에서 삭제합니다. 빈 threadId와 음수·안전하지 않은 정수 revision은 거부합니다. `running` 실행이 있으면 삭제를 거부하며 자동 취소하지 않으므로 호출자가 먼저 실행을 중단하고 종료 확정을 기다려야 합니다. 없는 스레드의 revision 0 삭제는 반복할 수 있습니다.
- 삭제는 낙관적 동시성 검사이며 영구 tombstone을 남기지 않습니다. 이미 준비한 입력과 새 동시 실행에는 기존 generation·revision 계약이 적용되며, 이후 스레드가 다시 생성될 수 있습니다.
- journal과 실행 메시지는 실행 중에도 배치로 확정해 행으로 기록하므로(최대 32개 이벤트 또는 50ms) 실행이 중단되어도 마지막으로 확정한 지점까지 부분 응답이 남습니다.
- 성공한 실행은 메시지·journal·종료 상태를 하나의 트랜잭션으로 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 커밋이 실패하면 `RUN_FINISHED`는 저장되지 않고 실행은 `interrupted`로 남습니다.
- 실행 중인 실행은 소유자별 임차로 보호합니다. 임차는 실행 중 10초마다 30초 뒤로 연장되므로, 다른 프로세스의 `recover()`는 임차가 살아 있는 실행을 `interrupted`로 바꾸지 않고 임차가 만료되었거나 서비스가 해제된 실행만 확정합니다. `recover()`는 LLM을 다시 호출하지 않습니다.
- 데이터베이스는 WAL과 `synchronous = NORMAL`을 사용합니다. 커밋된 트랜잭션은 프로세스가 비정상 종료해도 남지만, 운영체제 자체가 중단되면 마지막 커밋 몇 개가 유실될 수 있습니다.
- 한 실행은 시작한 서비스가 확정합니다. 다른 등록이 같은 `runId`로 실행을 시작하면 거부하고, 같은 실행의 종료 기록을 두 번 커밋해도 메시지와 revision은 한 번만 반영합니다.

`pnpm test --filter=@keundal/plugin-store-sqlite`는 실제 SQLite 파일과 가짜 `llm` 서비스를 사용해 커밋 순서, revision 충돌, 실행 중 journal과 부분 응답의 내구성, 임차와 재등록 복구, 취소·중단·실패 확정을 검증합니다.
