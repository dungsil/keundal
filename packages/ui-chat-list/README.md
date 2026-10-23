# @keundal/ui-chat-list

사이드바의 대화 목록과 대화 검색 대화상자를 제공하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.chatRuntime`의 `chats`로 화면을 그립니다. 이 패키지는 슬롯을 선언하지 않고 `@keundal/ui-layout`이 선언한 슬롯에만 등록합니다.

```ts
import * as chatList from '@keundal/ui-chat-list/plugin'
```

## 등록하는 슬롯

- `layout.sidebar`의 `actions`(order 0): 새 대화와 검색 메뉴입니다. 항목에 마우스를 올리거나 포커스를 두면 `meta+o`, `meta+k` 단축키를 표시합니다.
- `layout.sidebar`의 `history`(order 10): 날짜별로 묶은 대화 목록입니다. 항목마다 이름 변경 버튼과 삭제 버튼이 있습니다. `chats`를 불러오기 전에는 서버 렌더링 결과를 포함하여 스켈레톤을 표시합니다.
- `layout.overlay`의 `search`: `UDashboardSearch` 대화상자와 `meta+o` 단축키입니다. 단축키를 누르면 새 대화 화면(`/`)으로 이동합니다.

사이드바가 접히면 `actions`는 아이콘만 표시하고 `history`는 그리지 않습니다.

## 데이터

- `chats`: `runtime.chats`를 그대로 전달합니다. 값이 `undefined`인 동안 스켈레톤을 표시합니다.
- 이름 변경과 삭제: `useChatActions`가 확인 대화상자와 알림을 처리하고, 실제 변경은 `runtime.renameChat()`과 `runtime.deleteChat()`이 실행합니다.
- 검색 대화상자의 열림 상태: `apply()`에서 만든 반응형 상태 하나를 `actions`와 `search`가 함께 사용합니다.

## 파일

- `app/views/ChatActions.vue`, `ChatHistory.vue`, `ChatSearch.vue`: 슬롯에 등록하는 컴포넌트입니다.
- `app/lib/useChats.ts`: 대화를 오늘, 어제, 지난주, 지난달, 월별 순서로 묶습니다.
- `app/lib/useChatGroups.ts`: `ChatSummary`를 목록 항목으로 바꾸고 `useChats`로 묶습니다. 제목이 없는 대화에는 `chat.untitled` 문구를 붙입니다.
