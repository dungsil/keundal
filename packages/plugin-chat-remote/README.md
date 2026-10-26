# @keundal/plugin-chat-remote

`RemoteChatStore`로 HTTP 호스트의 대화·실행·제목 API에 연결합니다. UI나 로컬 실행 루프에 의존하지 않습니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.

`ChatStoreLike.respond()`는 선택적 `systemPrompt`를 받습니다. 공백이 아닌 값은 기본 응답 지침 뒤에 추가하고, 공백만 있는 값은 무시합니다. 제목 생성에는 적용하지 않습니다.

선택적 `promptPreset`은 실행을 시작할 때 검증·복사해 `forwardedProps.keundalPromptPreset`으로 HTTP 호스트에 전달합니다. 호스트의 공통 실행 루프가 저장된 대화를 준비한 뒤 프리셋을 조립합니다. 실행 중 프리셋 변경이나 재구독은 이미 시작한 응답의 입력을 바꾸지 않으며, 제목 생성에는 전달하지 않습니다.

원격 호스트와 desktop sidecar의 응답은 JSON 파싱 전에 32 MiB로 제한합니다.
오류 응답 본문은 16 KiB까지만 받습니다. SSE 프레임은 8 MiB에 프레임 헤더용 1 KiB를
더한 크기로 제한하며, 한 실행에서 받은 전체 바이트와 프레임 수는 재연결과 취소 후
journal 복구에도 이어서 계산합니다. 실행별 한도는 32 MiB와 16,384개입니다.
한도를 넘으면 본문 읽기와 호스트 실행을 취소하고 오류를 전달합니다.
