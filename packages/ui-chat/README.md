# @keundal/ui-chat

대화 화면(`/chat/:id`)을 제공하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.chatRuntime`의 모델 설정과 대화 저장소를 좁은 콜백으로 감싸 화면에 전달합니다. 추적(trace)과 도구 카드는 이 패키지가 선언하는 슬롯으로 다른 플러그인이 채웁니다.

```ts
import * as chat from '@keundal/ui-chat/plugin'
```

## 등록하는 슬롯

- `page.chat`(`@keundal/ui-layout`이 선언, 소유자 `{ chatId }`): 대화 화면 전체입니다.
  - 로딩 스켈레톤, 404 화면, 제목 메뉴(이름 변경·삭제), 공개 범위 대화상자, 메시지 목록, 대기열, 파일 끌어놓기를 그립니다.
  - 메시지 편집, 다시 생성, 분기, 투표를 처리하고 실패하면 알림을 표시합니다.
  - 입력창은 `<SlotFactory name="composer">`로 그립니다. 소유자는 `ComposerOwner`(`variant: 'docked'`)이며, 입력창 높이는 감싼 요소에서 측정해 `--chat-prompt-height`로 전달합니다.
  - 불러오는 동안 `runtime.setPending('chat', …)`로 시작 화면을 유지합니다.
  - 사이드바에서 이름을 바꾸면 `runtime.chats`의 제목을 따라 표시 제목을 갱신합니다. 응답이 끝나거나 제목이 생성되거나 분기하면 `runtime.refreshChats()`로 목록을 다시 읽습니다.

## 선언하는 슬롯

`page.chat`의 `children`으로 선언하며 소유자 타입은 `@keundal/ui/app/contracts/chat.ts`에 있습니다.

- `chat.message.tool`(keyed): 도구 호출 카드입니다. 키는 `part.type`에서 `tool-`을 뺀 도구 이름이고 소유자는 `{ part, message }`입니다. 항목이 없는 도구는 이 패키지의 기본 카드(`plugin.tool*` 문구, 입력과 출력을 JSON으로 표시)로 그립니다.
- `chat.message.footer`(list): 각 메시지 내용 아래에 렌더링합니다. 소유자는 `{ chatId, message, messages, status }`입니다.
- `chat.indicator`(list): 첫 응답을 기다리는 표시기와 `Thinking…` 문구 옆에 렌더링합니다. 소유자는 `{ chatId, messages, status }`입니다.
- `chat.observer`(list): 화면을 그리지 않는 항목입니다. 소유자의 `subscribe(listener)`로 이 화면의 모든 AG-UI 이벤트를 받고 `pendingRunId`로 대화를 열 때 진행 중이던 실행을 알 수 있습니다. 구독은 반환된 함수로 해제합니다.

## 데이터

- `model`, `titleModel`, `webSearch`, `reasoning`, `chats`: `runtime`의 반응형 값을 그대로 전달합니다.
- 대화 저장소 호출(`get`, `respond`, `steer`, `enqueue`, `dequeue`, `truncate`, `branch`, `vote`): `chatId`를 묶은 콜백이며 `runtime.store`는 콜백 안에서만 읽습니다. 저장소는 브라우저에서 연결한 뒤에 존재합니다.
- `ensureConfigured`, `refreshChats`, `rename`, `remove`, `setPending`: `runtime`의 같은 이름 메서드를 감싼 콜백입니다.

## 파일

- `app/views/ChatPage.vue`: 슬롯에 등록하는 대화 화면입니다.
- `app/views/ChatTitle.vue`, `ChatVisibility.vue`, `ChatSkeleton.vue`, `ChatIndicator.vue`, `ChatQueue.vue`: 화면의 구성 요소입니다.
- `app/views/message/`: 메시지 내용, 동작 버튼, 편집 양식입니다.
- `app/lib/use-keundal-chat.ts`: 전송·중단·편집·재생성·대기열 상태를 관리하는 컴포저블입니다. Nuxt 자동 가져오기에 의존하지 않으므로 단위 테스트에서 그대로 사용합니다.
- `app/lib/messages.ts`: 인접한 텍스트 조각을 합치고 원문 기준 출처 위치를 보존합니다. 렌더러의 문법은 만들지 않습니다.

본문과 추론은 `@keundal/ui`의 `ChatMarkdown`을 사용합니다. 구현은 `markdown` 팩터리에 등록하며, 기본 구현인 `@keundal/ui-markdown-comark`가 Comark 설정과 보안 경계를 소유합니다.
