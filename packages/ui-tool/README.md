# @keundal/ui-tool

대화 메시지의 도구 호출 카드를 그리는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인입니다.

## 등록하는 슬롯

모든 항목은 `chat.message.tool` 슬롯에 도구 이름을 `key`로 등록합니다. 소유자 값은 `{ part, message }`입니다. 이 슬롯에 항목이 없는 도구는 `@keundal/ui-chat`의 기본 도구 카드로 표시합니다.

| key                           | 컴포넌트         | 내용                                               |
| ----------------------------- | ---------------- | -------------------------------------------------- |
| `chart`                       | `Chart.vue`      | 선 그래프를 표시합니다. 처음 사용할 때 불러옵니다. |
| `weather`                     | `Weather.vue`    | 날씨 카드를 표시합니다. 처음 사용할 때 불러옵니다. |
| `delegate_task`               | `Subagent.vue`   | 서브에이전트의 작업과 응답을 표시합니다.           |
| `skill`                       | `SkillTool.vue`  | 스킬 불러오기 상태와 결과를 표시합니다.            |
| `web_search`, `google_search` | `SearchTool.vue` | 검색어와 출처 목록(`Sources.vue`)을 표시합니다.    |

## 선언하는 슬롯

이 패키지는 슬롯을 선언하지 않습니다. `chat.message.tool`은 `@keundal/ui-chat`이 선언합니다.

## 구조

- `app/lib/tool.ts`: `isToolStreaming`, `getSearchQuery`, `getSources`를 제공합니다.
- `app/views/`: 슬롯에 등록하는 컴포넌트입니다.
