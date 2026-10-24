# @keundal/ui-trace

대화 화면에 실행 추적(Trace)을 표시하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인입니다.

진행 중인 실행의 Trace 이벤트는 `chat.observer` 항목이 받아 대화마다 하나인 반응형 상태에 기록합니다. 이 상태는 `apply`에서 만들고, 관찰자가 해제되면 지웁니다. 상태는 `RUN_STARTED`마다 초기화하며, 활성 실행의 에이전트 Trace에 속한 Span만 최대 200개 보관합니다.

## 등록하는 슬롯

| 슬롯                  | 항목    | 내용                                                               |
| --------------------- | ------- | ------------------------------------------------------------------ |
| `chat.observer`       | `trace` | 화면을 그리지 않고 실행 이벤트를 구독합니다.                       |
| `chat.indicator`      | `trace` | 응답 메시지가 생기기 전까지 루트 Trace 패널을 표시합니다.          |
| `chat.message.footer` | `trace` | 가장 나중에 생성한 어시스턴트 응답 20개에 Trace 패널을 표시합니다. |

과거 실행의 기록은 `inject`가 돌려주는 `getRun` 콜백으로 읽습니다. 이 콜백은 `ctx.chatRuntime.store.getRun()`을 호출합니다.

## 선언하는 슬롯

이 패키지는 슬롯을 선언하지 않습니다. 등록하는 슬롯은 `@keundal/ui-chat`이 선언합니다.

## 구조

- `app/lib/trace.ts`: Span 트리, 타임라인, 사용량 집계 함수입니다.
- `app/lib/live-trace.ts`: 실행 이벤트를 진행 중인 Trace 상태에 반영하는 함수입니다.
- `app/views/`: `TraceViewer.vue`와 슬롯에 등록하는 컴포넌트입니다.

## 검증

```sh
pnpm --filter @keundal/ui-trace test
pnpm --filter @keundal/ui-trace typecheck
```
