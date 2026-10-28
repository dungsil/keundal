# @keundal/memory

프로젝트에서 확정한 설계 결정과 반복해서 필요한 정보를 대화 기록·축약 요약과 별도로 보관합니다.
`MemoryService`와 `ctx.memory`의 계약을 제공하며 SQLite 구현은 `@keundal/plugin-store-sqlite`에 있습니다.
Embedding 검색과 대화에서의 자동 추출은 제공하지 않습니다.

## Node.js 호스트에서 사용

`createNodeAgentHost({ ...options, projectId: 'keundal' }, createNodeComposition)`을 사용하거나,
`createAgentRuntime(env, { compose: createNodeComposition })`의 환경에 `KEUNDAL_PROJECT_ID=keundal`을 지정합니다.
`KEUNDAL_SQLITE_PATH`는 재시작 후에도 유지할 파일 경로여야 합니다. `:memory:`는 영속 저장소가 아닙니다.

프로젝트 ID를 생략하면 메모리 도구를 제공하지 않습니다. 빈 ID는 거부합니다.
프로젝트 ID를 지정했는데 저장소가 `memory` 서비스를 제공하지 않으면 호스트 시작을 거부합니다.
별도 조립에서는 다음처럼 공개 도구 팩터리를 사용합니다.

```ts
import { createMemoryTools } from '@keundal/memory/tools'
import sqliteStorePlugin from '@keundal/plugin-store-sqlite'

await ctx.plugin(sqliteStorePlugin, { path: '.data/keundal.sqlite' })
const tools = createMemoryTools(ctx.get('memory'), 'keundal')
// 앱이 tools를 에이전트의 tools 설정에 전달합니다.
```

프로젝트 ID는 앱이 정한 고정 범위입니다. 도구 인자로 다른 프로젝트를 선택할 수 없습니다.
한 호스트의 모든 대화는 이 범위를 공유하므로 서로 다른 사용자나 신뢰 범위에는 별도 호스트를 사용합니다.
프로젝트 선택 화면이나 브라우저 로컬 저장소 구현은 이 패키지에 포함하지 않습니다.

## 명시적 메모리 도구

| 도구            | 입력                                                    | 결과                                 |
| --------------- | ------------------------------------------------------- | ------------------------------------ |
| `memory_save`   | `title`, `content`, `sources`                           | 새 메모리                            |
| `memory_search` | `query`, `limit?`                                       | 출처와 revision을 포함한 메모리 배열 |
| `memory_get`    | `id`                                                    | 메모리 또는 `null`                   |
| `memory_update` | `id`, `expectedRevision`, `title`, `content`, `sources` | 수정한 메모리                        |
| `memory_delete` | `id`, `expectedRevision`                                | `{ "deleted": true }`                |

`sources`에는 `{ uri, label? }`를 하나 이상 지정합니다. 문서 URL이나 `file:` URI 등을 사용하며,
도구로 저장·수정한 대화의 `keundal://threads/<threadId>/runs/<runId>` 출처도 함께 기록합니다.
출처는 참조 정보이며 원문을 복사하거나 URI를 자동으로 열지 않습니다. 원문을 삭제해도 출처 문자열은 남습니다.
검색 결과는 참고 자료이지 실행 지침이 아닙니다.

대화에서 메모리를 자동 추출하는 작업은 없습니다. 저장·수정·삭제 도구의 설명은 사용자 요청이 있을 때만 변경하도록 안내합니다.
실제 도구 호출은 기존 도구 승인 정책을 따릅니다. 확인을 강제하려면 호스트의 `toolApproval.tools`에서
`memory_save`, `memory_update`, `memory_delete`를 `ask`로 설정합니다.

수정은 제목·본문·출처 전체를 교체합니다. 먼저 `memory_get`이나 `memory_search`로 현재 revision을 읽고
`expectedRevision`에 전달해야 합니다. 없는 항목·다른 프로젝트·오래된 revision은 변경하지 않고 오류를 반환합니다.
메모리는 세션 삭제·축약·호스트 재시작과 독립적으로 유지되며, 메모리 삭제 도구로 별도 삭제합니다.

## SQLite 검색 규칙

검색어를 공백으로 나누고 모든 검색어가 제목 또는 본문에 포함된 항목을 반환합니다.
부분 문자열을 문자 그대로 비교하므로 한두 글자의 한국어와 `%`, `_`도 검색할 수 있습니다.
ASCII 영문은 대소문자를 구분하지 않으며 형태소 분석·의미 검색·관련도 순위는 제공하지 않습니다.
수정 시각 내림차순, 같은 시각이면 ID 오름차순으로 정렬합니다. 기본 10개, 최대 50개입니다.
출처 문자열 자체는 검색하지 않습니다.

프로젝트 인덱스로 범위를 좁힌 뒤 해당 프로젝트의 텍스트를 검사합니다. 메모리가 커지면 전문 검색이나
선택적 Embedding 공급자를 검토할 수 있으며, 소비자는 SQLite 구현 대신 `MemoryService` 계약에 의존합니다.
