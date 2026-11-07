# 앱 상태 머신과 불변량

> 기준: `main`에서 조사한 서비스 계약과 `fix/chat-run-state-transitions`의 회귀 수정.
> 변경 시 전이표와 관련 테스트를 함께 갱신합니다. 모든 가능한 실행 경로를 모델 검사한 문서는 아닙니다.

## 1. 상태 머신 색인

| 상태 머신 | 명시적 상태 또는 암시적 상태 | 구현 | 검증·보장 |
| --- | --- | --- | --- |
| 생성 실행 (Generation) | `running` → `completed / failed / cancelled / interrupted` | `packages/generation/src/generation.ts`, `packages/plugin-store-{memory,sqlite,indexeddb}/src/generation.ts` | `docs/run-control.md`, 저장소별 recovery/conformance 테스트 |
| 채팅 실행과 Queue (ChatRuns) | `idle / active / closing`, Queue `queued / removed / committed` | `packages/chat/src/run-queue.ts`, `packages/plugin-chat-local/src/index.ts`, `packages/chat-http/src/index.ts` | `packages/chat/tests/run-queue.test.ts`, `packages/ui-chat/tests/chat-queue.test.ts` |
| Steer 전달 | `not-submitted / delivering / accepted / rejected / applied / requeued` | `packages/chat/src/run-queue.ts`, `packages/tool-execution/src/index.ts` | `packages/chat/tests/run-queue.test.ts`, `packages/agent-host/tests/run-control.test.ts` |
| 세션 Revision | `prepared(revision N) / committed(N+1) / conflict / deleted` | `packages/session/src/session.ts`, `packages/plugin-store-*/src/session.ts` | 저장소별 conformance/store 테스트 |
| 백그라운드 작업 | `queued / running / completed / failed / cancelled / interrupted` | `packages/task/src/index.ts`, `packages/task-memory/src/index.ts` | `packages/task-memory/tests/tasks.test.ts` |
| 도구 승인 | `requested / decided(allow|deny) / cancelled` (마지막 상태는 대기 요청 해제의 암시적 상태) | `packages/tool-approval/src/index.ts` | `packages/agent-host/tests/run-control.test.ts` |
| journal 재구독 | `replay / following / ended / aborted` | `packages/generation/src/journal-follow.ts` | 저장소별 recovery 및 호스트의 구독 테스트 |
| 자동화 전달 | `dispatching / submitted / failed / interrupted / skipped` | `packages/automation/src/index.ts` | 관련 자동화 테스트 |

## 2. 생성 실행 상태 전이

| 현재 | 사건 | 다음 | 불변량 |
| --- | --- | --- | --- |
| 없음 | 유효한 새 runId로 실행 시작 | running | 같은 runId의 활성 실행을 중복 등록하지 않음 |
| running | 성공한 스트림 종료 및 세션 commit | completed | 성공 `RUN_FINISHED`는 내구성 commit 이후 전달 |
| running | 스트림 실패 | failed | 기존 journal 및 부분 응답 보존 |
| running | 사용자 취소 | cancelled | 실제 작업의 AbortSignal 전파, 부분 응답 보존 |
| running | 프로세스 재시작·임차 만료 후 recover | interrupted | 모델·도구 재실행 금지 |
| terminal | subscribe / recover | 같은 terminal | 이벤트 재생만 수행하며 부작용 없음 |
| terminal | 동일 종료 commit 재시도 | 같은 terminal | revision 증가 및 메시지 중복 적용 금지 |

관련 계약: `packages/generation/src/generation.ts`, `packages/session/src/session.ts`, `docs/run-control.md`.
실제 저장소별 영속성 보장의 상세한 조건은 각 구현 및 conformance 테스트에서 확인해야 합니다.

## 3. 채팅 실행 상태 전이

| 현재 | 사건 | 다음 | 허용되는 동작 |
| --- | --- | --- | --- |
| idle | respond 시작 | active | 대화당 한 실행 등록 |
| active | enqueue | active | 메모리의 `queued`에 추가, id 중복 제거, 32개 상한 유지 |
| active | dequeue | active | 저장된 항목은 `removed`로 표시, 임시 항목은 제거 |
| active | steer | active | id별 전달이 완료된 경우에만 성공 반환 |
| active | 종료 커밋 시작 | closing | 새 enqueue/dequeue는 종료 완료 후 저장소에 적용 |
| closing | release | idle | 실패 시 대기 변경을 복구하고 등록 해제 |
| idle | enqueue/dequeue | idle | 저장소에 직접 반영 |
| active/closing | 같은 대화 respond | 금지 | 중복 실행 거부 |

### 필수 불변량

1. 같은 `threadId`에 활성 실행은 하나뿐입니다.
2. 동일 Steer 메시지 ID를 동시에 전송하면 하나의 결과를 공유합니다. 실패 또는 예외를 성공으로 보고하면 안 됩니다.
3. 종료 중인 실행 객체에만 Queue 삭제를 기록하면 안 됩니다. 삭제 성공은 실제 저장된 Queue에 반영되어야 합니다.
4. `visibleQueue()`와 종료 커밋의 `mergeRunQueue()`는 같은 ID를 중복해서 표시하거나 기록하지 않아야 합니다.
5. 실행의 생성 결과와 Queue 변경을 확정하기 전에는 취소된 메시지를 다시 생성 대상으로 선택하면 안 됩니다.

## 4. Steer 상태 전이

| 현재 | 사건 | 다음 | 허용 결과 |
| --- | --- | --- | --- |
| not-submitted | 유효한 active run에 전달 시작 | delivering | submitted에 한 번만 추가 |
| delivering | 같은 ID의 요청 | delivering | 기존 Promise를 공유 |
| delivering | 전달 성공 | accepted | 모든 동시 호출에 true |
| delivering | 전달 거절 | rejected | 모든 동시 호출에 false, submitted에서 제거 |
| delivering | 전달 예외 | rejected | 모든 동시 호출에 같은 실패, submitted에서 제거 |
| rejected | 재시도 | delivering | 실제 전달을 새로 시도 |
| accepted | 안전한 모델 경계에서 소비 | applied | journal에 반영 |
| accepted | 실행이 소비 전에 종료 | requeued | Queue 앞으로 이동 |

## 5. 검증된 잘못된 전이와 변경

### P1-A: `delivering → accepted`로 조기 보고

- **근거:** `ChatRuns.steer()`의 기존 `run.submitted.some(...)` 조건이 전송 Promise의 완료 이전에 `true`를 반환했습니다.
- **도달 경로:** 동일 ID에 대한 두 동시 요청 → 첫 `deliver()` 보류 → 두 번째는 즉시 `true` → 첫 전달 실패.
- **영향:** 화면에서 Steer를 받아들인 것처럼 표시하지만 서버/에이전트에 반영되지 않을 수 있습니다.
- **수정:** 실행 객체 및 메시지 ID별 진행 중 Promise를 공유하며 완료 이후에만 결과를 반환합니다.
- **회귀:** `packages/chat/tests/run-queue.test.ts`의 실패/예외/재시도 테스트.

### P1-B: `closing → cancelled-in-memory`로 삭제가 유실됨

- **근거:** 기존 `ChatRuns.dequeue()`는 `storage.read()` 이후 `closing`을 확인하지 않고 `run.removed`만 변경했습니다.
- **도달 경로:** dequeue 중 저장소 읽기 지연 → 종료 확정 및 active 해제 → 이전 실행 객체만 변경 → 저장소 Queue 유지.
- **영향:** UI에서 제거된 메시지가 다음 대기 실행에서 다시 사용될 수 있습니다.
- **수정:** 저장소를 읽은 뒤 `closing`을 재검사하며 최신 실행 상태에 대해 삭제를 다시 수행합니다.
- **회귀:** `packages/chat/tests/run-queue.test.ts`의 종료 도중 Queue 취소 테스트.

## 6. 재시도·동시성 검증 규칙

- Steer 실패 및 예외는 성공으로 처리하지 않습니다. 재시도는 완료된 전달에 의해서만 승인됩니다.
- 실행 성공을 다시 구독하거나 복구할 때 LLM·도구를 다시 실행하지 않습니다.
- journal은 `afterSequence`보다 큰 sequence만 한 번씩 전달해야 합니다.
- 세션 commit의 중복 완료 및 revision 충돌은 각 저장소 구현별로 확인합니다.
- 비동기 동시성 테스트는 완료 순서가 일정하도록 제어 가능한 Promise를 사용하고 시간 기반 sleep에 의존하지 않습니다.

### 검증 범위와 미검증 항목

본 변경에서는 공용 `ChatRuns`의 두 경합을 코드와 제어 가능한 Promise 기반 회귀 테스트로 다룹니다. 앱의 전체 상태 공간을 탐색하거나 외부 프로세스를 다중 실행한 모델 검사는 수행하지 않았습니다. SQLite/IndexedDB의 실제 다중 인스턴스 충돌, 네트워크 불확실성 아래의 멱등성, 도구의 외부 부작용에 대한 exactly-once 보장은 별도 검증이 필요합니다.

## 7. 유지 관리

상태 또는 전이를 변경하는 PR은 이 파일의 해당 행, 보호할 불변량, 회귀 테스트 경로를 함께 갱신합니다. 결함 보고에는 재현 순서, 현재/기대 상태, 코드 근거와 테스트 실행 결과를 구분해 기록합니다. 변경할 때 `pnpm --filter @keundal/chat test`, `pnpm test`, `pnpm typecheck`, `pnpm lint`를 실행하고 확인한 결과만 PR에 기록합니다.
