# 예약 실행과 이벤트 기반 작업

`@keundal/automation`은 `AutomationService`, `AutomationStore`와 Cordis의 `ctx.automation`, `ctx.automationStore` 계약을 제공합니다. `@keundal/automation-node`는 Node 호스트의 타이머와 작업 제출을 구현하며, SQLite 플러그인은 일정과 수신 이력을 저장합니다. 실행과 결과 저장은 기존 `TaskService`가 담당합니다.

## 실행 환경

기본 Node 조립은 작업 저장소를 복구한 뒤 자동화를 시작합니다. `createNodeAgentHost()` 또는 `createAgentRuntime()`의 `automation: false` 옵션으로 끌 수 있습니다. 사용자 조립은 `tasks`와 `automationStore`를 함께 제공해야 합니다. 브라우저만 실행하는 구성에는 스케줄러가 없습니다.

예약 실행에는 **상시 실행 중인 Node 호스트**가 필요합니다. 서버리스 요청 처리, 브라우저 종료, desktop 종료·절전 중에는 실행을 보장하지 않습니다. 동일 SQLite 파일에는 작업 실행 서비스와 스케줄러를 각각 하나만 연결합니다. 여러 호스트의 분산 실행과 리더 선출은 지원하지 않습니다.

## 앱에서 관리하기

Node 호스트에 연결한 web 앱과 desktop 앱의 **설정 → 예약 작업**에서 이름과 실행 지시를 입력하고 Cron·Webhook·이벤트 조건을 등록합니다. Cron에는 5개 필드의 표현식과 IANA 시간대를 지정합니다. 시간대는 처음에 브라우저 설정을 사용하며 직접 바꿀 수 있습니다. 다음 실행 시각과 이력의 시각은 화면을 보는 환경의 현지 시각으로 표시합니다.

등록한 작업을 활성화·비활성화하거나 삭제하고, 실행 이력에서 완료·실패·생략·중단 상태와 응답·오류를 확인할 수 있습니다. 삭제한 정의의 실행 이력도 전체 목록에 남습니다. 브라우저 전용 실행 방식에는 호스트 연결이 필요하다는 안내를 표시합니다.

`@keundal/ui-automation`은 앱이 열려 있는 동안 정의와 전체 실행 이력을 5초 간격으로 조회합니다. 첫 조회의 과거 이력은 알리지 않고, 이후 새로 확인한 완료·실패·중단만 앱 알림으로 표시합니다. 알림에서 실행 이력으로 이동할 수 있으며, 알림이 사라진 뒤에도 결과는 이력에 남습니다. OS 알림은 제공하지 않습니다. 앱을 닫았을 때는 아래의 외부 Webhook 알림을 사용할 수 있습니다.

실행 상태의 기준은 `AutomationHistory`와 연결된 `TaskSnapshot`입니다. 앱 알림은 UI 플러그인이 이 상태를 표시하는 방식이며 스케줄러나 저장소가 UI에 의존하지 않습니다. 외부 알림도 같은 실행 상태를 사용합니다.

## 외부 Webhook 알림

`@keundal/notification`은 `NotificationService`, `NotificationStore`와 `ctx.notification`, `ctx.notificationStore` 계약을 제공합니다. `@keundal/plugin-notification-webhook`의 `WebhookNotificationService`가 HTTP 전송을 담당하고, SQLite 플러그인이 전송 이력을 저장합니다. 기존 앱 내 알림과 독립적으로 동작하며 UI 조회나 브라우저 연결이 필요하지 않습니다.

Node 호스트에 `KEUNDAL_NOTIFICATION_WEBHOOK_URL`을 지정하면 외부 알림을 켭니다. 인증이 필요한 수신 서버에는 `KEUNDAL_NOTIFICATION_WEBHOOK_TOKEN`을 함께 지정하면 `Authorization: Bearer <token>`을 보냅니다. 프로그램에서 조립할 때는 `createNodeAgentHost()`의 `notificationWebhook: { url, token? }`을 사용합니다. 사용자 조립은 `notificationStore`를 제공해야 하며, 다른 공급자는 `NotificationService`를 구현해 `ctx.notification`에 등록할 수 있습니다.

주소와 인증 정보는 호스트 운영자가 관리합니다. 자동화 정의나 HTTP 등록 본문으로 받지 않고 SQLite 전송 이력에도 저장하지 않습니다. 대상은 정규화한 URL의 SHA-256 값으로 구분합니다. 같은 URL에서 토큰만 바꾸면 기존 전달 이력을 유지하지만 URL을 바꾸면 새로운 대상으로 취급합니다. HTTP(S)만 허용하고 URL의 사용자 정보·fragment와 리다이렉트는 허용하지 않습니다. 실제 운영에는 HTTPS를 사용하고, 실행 결과와 오류를 받아도 되는 신뢰할 수 있는 수신 서버만 지정하세요.

호스트는 1초 간격으로 완료·실패·중단된 실행을 확인해 전송 대기 상태로 저장합니다. 대기·실행·겹침으로 생략된 작업은 알리지 않습니다. 작업 취소는 `automation.interrupted`로 전달합니다. 제출 실패와 복구 중 확인한 중단도 알리며, 정의를 삭제해도 남아 있는 실행 결과는 전달합니다. 알림을 처음 켜거나 URL을 바꾸면 저장된 과거 종료 이력도 해당 대상으로 한 번씩 전달합니다.

요청은 JSON 본문의 `POST`이며, `Idempotency-Key` 헤더에 본문의 `id`와 같은 값을 보냅니다. `type`은 `automation.completed`, `automation.failed`, `automation.interrupted` 중 하나입니다. `content`에는 실행 응답 또는 부분 응답을 담고, 오류가 있으면 `error`를 추가합니다. `taskId`는 작업 제출에 성공한 경우에만 있습니다. `createdAt`은 작업의 마지막 변경 시각이며, 작업이 없으면 수신 시각을 사용합니다. 시각은 Unix 밀리초입니다.

```json
{
  "id": "automation:attempt-23",
  "type": "automation.completed",
  "automationId": "morning",
  "attemptId": "attempt-23",
  "runId": "run-42",
  "taskId": "task-17",
  "content": "예약 실행 결과",
  "createdAt": 1793232000000
}
```

전송 정책은 다음과 같습니다.

- 2xx 응답이면 `delivered`로 저장하고 같은 대상·ID를 다시 보내지 않습니다. 동시에 조회하거나 호스트를 재시작해도 전달 이력을 유지합니다.
- 네트워크 오류, 10초 응답 제한 초과, HTTP 408·429·5xx만 최초 요청을 포함해 최대 5회 시도합니다. 재시도 간격은 1·2·4·8초이며, 429·503의 `Retry-After`가 더 길면 최대 60초까지 기다립니다.
- 그 밖의 응답과 재시도 소진은 `failed`로 남기고 자동으로 다시 보내지 않습니다. 알림 실패는 작업 결과를 바꾸거나 작업을 다시 실행하지 않습니다.
- 종료 시 진행 중인 HTTP 요청을 취소하고 대기 기록을 보존합니다. 같은 SQLite 파일과 URL로 호스트를 다시 시작하면 남은 횟수 안에서 전송을 이어갑니다. 호스트 종료로 중단된 작업의 알림은 다음 시작 때 확인합니다.
- 수신 성공 직후 응답이 유실되거나 `delivered` 저장 전에 프로세스가 종료되면 같은 알림이 다시 도착할 수 있습니다. 수신 측은 `Idempotency-Key` 또는 본문의 `id`로 중복 처리를 막아야 합니다. 정확히 한 번 전달이나 무제한 전달 보장은 제공하지 않습니다.

전송 상태·횟수·다음 시각과 오류 분류는 `host.ctx.notificationStore.list(target)`으로 조회할 수 있습니다. 이 조회 API는 호스트 내부 계약이며 별도 HTTP 관리 API나 설정 UI는 없습니다. 같은 SQLite 파일에는 전송 실행자를 하나만 연결합니다. 앱을 닫아도 **Node 호스트가 계속 실행 중이면** 알림을 보냅니다. desktop을 종료해 sidecar도 멈추거나 서버가 꺼진 동안에는 예약 실행과 전송이 동작하지 않습니다.

## HTTP 등록과 조회

모든 경로에는 기존 HTTP API와 같은 `Authorization: Bearer <token>`이 필요합니다. 웹 앱에서는 `/api/agent` 접두사를 붙입니다. 공개 Webhook이나 공급자별 서명 검증 경로는 제공하지 않습니다. 외부 공급자가 Bearer 인증과 아래 본문을 보낼 수 없으면 인증된 중계 서버를 사용합니다. 토큰을 URL이나 일정 정의에 넣지 않습니다.

| 메서드와 경로                   | 동작                                                    |
| ------------------------------- | ------------------------------------------------------- |
| `PUT /automations/:id`          | 일정을 등록하거나 대체합니다.                           |
| `GET /automations`              | 등록한 정의와 `nextRunAt`을 조회합니다.                 |
| `DELETE /automations/:id`       | 정의를 삭제합니다. 기존 작업과 수신 이력은 유지합니다.  |
| `POST /automations/:id/webhook` | 활성 Webhook에 이벤트를 전달합니다.                     |
| `POST /automation-events`       | 같은 이름으로 등록된 활성 자동화에 이벤트를 전달합니다. |
| `GET /automations/:id/history`  | 수신 이력과 연결된 작업의 상태·결과·오류를 조회합니다.  |
| `GET /automation-history`       | 삭제한 정의를 포함한 전체 실행 이력을 조회합니다.       |

자동화 ID는 영문, 숫자, `_`, `-`로 구성한 1~128자입니다. `PUT` 본문 예시는 다음과 같습니다.

```json
{
  "label": "아침 요약",
  "enabled": true,
  "trigger": {
    "type": "cron",
    "expression": "0 9 * * *",
    "timezone": "Asia/Seoul"
  },
  "input": {
    "messages": [{ "id": "prompt", "role": "user", "content": "오늘 확인할 내용을 요약해 줘" }],
    "state": {},
    "context": [],
    "tools": []
  }
}
```

Cron은 분·시·일·월·요일의 5개 필드와 명시한 IANA 시간대를 사용합니다. 1초 간격으로 만료 일정을 확인하며, 시간대 계산은 `cron-parser`에 맡깁니다. 정의를 대체하거나 다시 활성화하면 현재 시각 다음의 실행 시각을 계산합니다. 호스트가 늦게 깨어나 여러 일정이 밀렸으면 한 번만 제출하고 다음 미래 일정으로 이동합니다. 누락된 일정마다 작업을 쌓지 않습니다.

Webhook은 `trigger`를 `{ "type": "webhook" }`으로 바꿔 등록합니다. `POST /automations/:id/webhook` 본문은 다음 형식입니다.

```json
{ "id": "delivery-123", "payload": { "branch": "main" } }
```

이름 기반 이벤트는 `{ "type": "event", "name": "build.failed" }`로 등록합니다. `POST /automation-events`에는 다음 본문을 보냅니다. Node 소비자는 `host.services.automation.emit(name, event)`로도 전달할 수 있습니다. 호스트 내부의 모든 이벤트를 자동으로 구독하지는 않으며, 이벤트 공급자가 이 진입점을 호출합니다.

```json
{ "name": "build.failed", "id": "build-123", "payload": { "exitCode": 1 } }
```

수신 ID는 1~256자로 지정하고 재전송할 때 같은 값을 사용합니다. `payload`는 선택 사항이며 새 작업의 사용자 메시지에 신뢰할 수 없는 이벤트 데이터로 덧붙입니다. 자동화마다 새 대화·실행 ID를 생성하고, 호스트의 기본 모델과 도구·권한 정책으로 실행합니다. 입력 템플릿은 SQLite에 저장하므로 인증 정보와 비밀 값을 넣지 않습니다.

## 중복, 겹침과 실패

작업을 제출하기 **전에** 자동화 ID와 수신 키를 유일하게 저장합니다. Cron은 예정 시각, Webhook·이벤트는 수신 ID가 키입니다. 중복 수신은 같은 이력과 작업을 반환하며, 정의를 삭제하고 같은 ID로 다시 등록해도 기존 키를 재사용하지 않습니다.

이전 작업이 대기·실행 중이거나 취소 후 실행 정리 중이면 새 수신을 `skipped`로 기록합니다. 별도 대기열에 넣거나 나중에 재시도하지 않습니다. 서로 다른 자동화의 동시 실행 한도는 기존 `TaskService`를 따릅니다.

수신 이력의 `status`는 다음과 같습니다.

- `dispatching`: 수신 키를 저장했고 작업 제출을 진행 중입니다.
- `submitted`: 작업을 제출했습니다. 실행 성공 여부는 연결된 `task.status`, 응답은 `task.content`, 실행 오류는 `task.error`로 확인합니다.
- `failed`: 작업 제출에 실패했습니다. `error`에 이유를 보관합니다.
- `skipped`: 이전 작업이 아직 끝나지 않아 제출하지 않았습니다.
- `interrupted`: 재시작 시 수신 기록만 있고 연결할 작업을 찾지 못했습니다.

재시작하면 기존 작업 저장소가 미완료 작업을 `interrupted`로 복구합니다. 제출 중이던 수신 기록은 저장된 `runId`로 작업과 다시 연결하며, 작업이 없으면 `interrupted`로 남깁니다. 실패·취소·중단된 실행은 자동 재시도하지 않습니다. 수신 키 저장 직후 프로세스가 종료되면 실제 실행 없이 이벤트가 소비될 수 있습니다. 외부 부작용의 중복을 피하는 **최대 한 번 제출** 정책이며, 정확히 한 번 실행이나 전달 보장을 제공하지 않습니다.

작업 취소는 기존 `POST /tasks/:id/cancel`을 사용합니다. 정의 삭제·비활성화는 이미 제출한 작업을 취소하지 않습니다. 호스트 종료는 새 수신을 막고 제출 중인 요청을 정리한 뒤 작업·저장소를 종료합니다. 결과와 부분 응답의 내구성은 [백그라운드 작업 계약](../../docs/adr/0006-background-tasks.md)을 따릅니다.
