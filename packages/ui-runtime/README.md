# @keundal/ui-runtime

채팅 플랫폼 연결과 UI 플러그인이 공유하는 화면 상태를 Cordis 서비스 `ctx.chatRuntime`으로 제공합니다.

- 연결: `start()`, `store`, `platform`, `remoteAgent`
- 설정: `settings`, `saveSettings()`, `ensureConfigured()`, `saveMcpSettings()`
- 모델: `model`, `models`, `selectedModel`, `defaultModel`, `titleModel`, `switching`, `refreshModels()`
- 입력 옵션: `systemPrompt`, `saveSystemPrompt()`, `webSearch`, `reasoning`, `reasoningLevels`, `promptCatalog()`
- 대화 목록: `chats`, `refreshChats()`, `renameChat()`, `deleteChat()`
- 시작 화면: `setPending()`, `ready`

서버에서도 서비스를 만들기 때문에 플러그인은 서버와 브라우저에 같은 항목을 등록합니다. `start()`는 브라우저에서 한 번 호출하며, 저장된 설정을 읽지 못하면 `SettingsLoadError`를 던집니다. `store`와 `platform`은 연결하기 전에 읽으면 예외를 던집니다. 서비스를 해제하면 연결과 MCP 관리자를 닫습니다.

`start()`는 `localStorage`의 `keundal:system-prompt`에서 사용자 지침을 복원합니다. `saveSystemPrompt()`는 앞뒤 공백을 제거한 뒤 저장하고 화면 상태를 갱신합니다. 빈 값은 저장소에서 삭제하며, 저장에 실패하면 기존 화면 상태를 유지하고 예외를 던집니다.

UI 플러그인은 이 서비스를 컴포넌트에 직접 넘기지 않고, 필요한 ref와 콜백만 `inject` 결과로 전달합니다. [UI 플러그인 문서](../../docs/ui-plugins.md)를 참고합니다.
