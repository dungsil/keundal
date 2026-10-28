# 예약 실행과 이벤트 기반 작업

`@keundal/automation`은 `AutomationService`, `AutomationStore`와 Cordis의 `ctx.automation`, `ctx.automationStore` 계약을 제공합니다. `@keundal/automation-node`는 Node 호스트의 타이머와 작업 제출을 구현하며, SQLite 플러그인은 일정과 수신 이력을 저장합니다. 실행과 결과 저장은 기존 `TaskService`가 담당합니다.

## 실행 환경

기본 Node 조립은 작업 저장소를 복구한 뒤 자동화를 시작합니다. `createNodeAgentHost()` 또는 `createAgentRuntime()`의 `automation: false` 옵션으로 끌 수 있습니다. 사용자 조립은 `tasks`와 `automationStore`를 함께 제공해야 합니다. 브라우저만 실행하는 구성에는 스케줄러가 없습니다.

예약 실행에는 **상시 실행 중인 Node 호스트**가 필요합니다. 서버리스 요청 처리, 브라우저 종료, desktop 종료·절전 중에는 실행을 보장하지 않습니다. 동일 SQLite 파일에는 작업 실행 서비스와 스케줄러를 각각 하나만 연결합니다. 여러 호스트의 분산 실행과 리더 선출은 지원하지 않습니다.

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
