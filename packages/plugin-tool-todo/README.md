# TODO 도구

`@keundal/plugin-tool-todo`는 에이전트가 여러 단계로 된 작업의 진행 상태를 기록하는 `todo_write` 도구를 제공합니다.

```ts
import { createTodoTools } from '@keundal/plugin-tool-todo'

const tools = createTodoTools()
```

## 입력과 결과

호출할 때마다 전체 목록을 전달합니다. 기존 항목의 `id`를 유지하고, 완료한 항목도 목록에 남깁니다. 삭제하려는 항목은 다음 목록에서 제외하고, 빈 배열을 전달하면 목록을 비웁니다.

```json
{
  "todos": [
    { "id": "inspect", "content": "기존 코드 확인", "status": "completed" },
    { "id": "implement", "content": "도구 구현", "status": "in_progress" },
    { "id": "verify", "content": "검증 실행", "status": "pending" }
  ]
}
```

상태는 `pending`, `in_progress`, `completed` 중 하나입니다. ID와 내용의 앞뒤 공백을 제거하며, 빈 값·중복 ID·둘 이상의 `in_progress` 항목·정의하지 않은 필드는 거부합니다. 취소된 실행도 거부합니다.

결과는 검증한 `{ todos }`의 JSON 문자열입니다. 별도 저장소나 전역 목록은 없으며, 대화에 기록된 가장 최근의 성공한 도구 결과가 현재 목록입니다. 기존 세션과 Generation Journal에 다른 도구 결과와 함께 보관됩니다. 대화 축약 뒤의 독립적인 TODO 조회나 복구는 제공하지 않습니다.

## 앱 구성

웹과 desktop의 기본 도구 목록에 포함되며, 설정의 큰달 플러그인 목록에서 독립적으로 끄거나 켤 수 있습니다. Node.js의 코딩 에이전트도 이 선택을 따릅니다. 전용 결과 UI 대신 기존 공통 도구 결과 화면을 사용합니다.

웹 매니페스트에서는 `{ "module": "builtin:todo" }`, Node.js 매니페스트에서는 `{ "module": "@keundal/plugin-tool-todo" }`로 선택합니다. 명시한 `tools` 목록은 기존처럼 기본 도구 목록을 대체합니다. Node.js에서 직접 조립할 때는 `createTodoTools()`를 `defaultTools`에 전달합니다.
