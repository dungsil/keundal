# `@keundal/plugin-store-indexeddb`

`indexedDBStorePlugin`은 브라우저의 IndexedDB에 `session`과 `generation` 서비스를 함께
저장합니다. `threads`, `runs`, `journal`을 분리하며, 스트림 이벤트는 사용자에게 전달하기 전에
append-only journal에 확정합니다. 성공한 `RUN_FINISHED`는 세션 메시지, revision, 실행 종료
기록을 하나의 `readwrite` transaction으로 저장한 뒤 전달합니다.

```ts
import indexedDBStorePlugin from '@keundal/plugin-store-indexeddb'

await ctx.plugin(indexedDBStorePlugin, { databaseName: 'my-agent' })
```

기본 데이터베이스 이름은 `keundal`입니다. `databaseName`으로 앱별 저장 공간을 분리할 수
있고, 테스트나 별도 브라우저 컨텍스트에서는 `indexedDB`를 전달할 수 있습니다. 이미 생성한
`IndexedDBStore`를 `store`로 전달하면 플러그인이 해제되어도 저장소 연결의 소유권은 호출자에게
남습니다. 그렇지 않은 경우 플러그인이 해제될 때 생성한 저장소 연결을 닫습니다.

```ts
import { IndexedDBStore } from '@keundal/plugin-store-indexeddb'

const store = new IndexedDBStore({ databaseName: 'my-agent' })
await ctx.plugin(indexedDBStorePlugin, { store })
// 호출자가 더 이상 사용하지 않을 때 닫습니다.
store.close()
```

실행별 Web Locks를 생성부터 종료 커밋 또는 서비스 해제까지 유지합니다. 따라서 같은 브라우저
프로필의 다른 탭에서 `recover()`를 호출해도 살아 있는 실행을 `interrupted`로 바꾸지 않습니다.
`recover()`는 실행 lock을 즉시 얻을 수 있는 경우에만 중단된 실행을 확정하며 LLM을 다시 호출하지
않습니다.

Web Locks API는 secure context에서만 제공되므로 HTTPS 또는 `localhost`에서 실행해야 합니다.
`navigator.locks`가 없는 환경에서는 실행과 복구가 명시적인 오류로 실패합니다. 테스트용
`IndexedDBStoreOptions`에는 `locks`와 `indexedDB`를 주입할 수 있습니다.

브라우저는 저장 공간 부족, 사용자가 사이트 데이터를 삭제한 경우, 브라우저 정책에 따라 IndexedDB
데이터를 제거할 수 있습니다. 장기 보존이 필요하면 사용자 동의가 가능한 시점에 애플리케이션이
`navigator.storage.persist()`를 요청해야 합니다. 이 플러그인은 저장 공간을 자동으로 영구화하지
않습니다.
