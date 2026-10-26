# @keundal/plugin-chat-local

주입받은 Cordis 서비스와 에이전트 등록 함수로 대화를 실행합니다. `new ChatStore(ctx, mountAgent)`로 만들며 저장소나 기본 에이전트를 직접 등록하지 않습니다.

`@keundal/plugin-chat-local/keundal`의 `createKeundalChat()`은 `KeundalChatRuntime`을 반환합니다. 실행 입력은 `KeundalChatRequest`, 에이전트 등록 함수는 `MountAgent`로 선언합니다.

`ChatStoreLike.respond()`는 선택적 `systemPrompt`를 받습니다. 공백이 아닌 값은 기본 응답 지침 뒤에 추가하고, 공백만 있는 값은 무시합니다. 제목 생성에는 적용하지 않습니다.

선택적 `promptPreset`은 실행을 시작할 때 복사해 `forwardedProps.keundalPromptPreset`으로 에이전트에 전달합니다. 공통 실행 루프가 세션 준비 후 블록과 변수를 조립하므로 브라우저와 호스트가 같은 순서를 사용합니다. 실행 중 프리셋을 편집해도 진행 중인 응답에는 반영하지 않습니다. 제목 생성에는 전달하지 않습니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
