# @keundal/ui-runtime

채팅 플랫폼 연결과 UI 플러그인이 공유하는 화면 상태를 Cordis 서비스 `ctx.chatRuntime`으로 제공합니다.

- 연결: `start()`, `store`, `platform`, `remoteAgent`
- 설정: `settings`, `saveSettings()`, `ensureConfigured()`, `saveMcpSettings()`
- 모델: `model`, `models`, `selectedModel`, `defaultModel`, `titleModel`, `switching`, `refreshModels()`
- 입력 옵션: `promptPresets`, `promptPreset`, `savePromptPresets()`, `webSearch`, `reasoning`, `reasoningLevels`, `promptCatalog()`
- 실행 정책: `subagentRoles`, `saveSubagentRoles()`, `runBudget`, `saveRunBudget()`
- 대화 목록: `chats`, `refreshChats()`, `renameChat()`, `deleteChat()`
- 시작 화면: `setPending()`, `ready`

서버에서도 서비스를 만들기 때문에 플러그인은 서버와 브라우저에 같은 항목을 등록합니다. `start()`는 브라우저에서 한 번 호출하며, 저장된 설정을 읽지 못하면 `SettingsLoadError`를 던집니다. `store`와 `platform`은 연결하기 전에 읽으면 예외를 던집니다. 서비스를 해제하면 연결과 MCP 관리자를 닫습니다.

`start()`는 `localStorage`의 `keundal:prompt-presets`에서 프리셋과 적용할 프리셋 ID를 복원합니다. 새 설정이 없으면 기존 `keundal:system-prompt`를 기본 프리셋으로 읽되 원본은 지우지 않습니다. 새 설정이 있으면 적용할 프리셋이 없어도 이전 지침을 다시 읽지 않습니다. `savePromptPresets()`는 전체 설정을 검증하고 저장한 뒤 화면 상태를 갱신합니다. 저장에 실패하면 기존 화면 상태를 유지하고 예외를 던집니다. `promptPreset`은 현재 선택한 프리셋이며, 응답을 시작할 때 실행 입력으로 전달합니다.

UI 플러그인은 이 서비스를 컴포넌트에 직접 넘기지 않고, 필요한 ref와 콜백만 `inject` 결과로 전달합니다. [UI 플러그인 문서](../../docs/ui-plugins.md)를 참고합니다.

`runBudget`은 `keundal:run-budget`에서 복원하며, 설정이 없으면 실행 방식의 기본 정책을 유지합니다. `saveRunBudget()`은 공용 `parseRunBudget()`으로 검증한 뒤 저장하며 저장 실패 시 현재 값을 유지합니다. `undefined`를 저장하면 요청별 재정의를 지웁니다. 채팅 응답을 시작할 때 예산을 캡처하여 로컬 실행과 호스트 HTTP 요청에 전달합니다. 제목 생성에는 적용하지 않습니다.
