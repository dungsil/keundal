# @keundal/plugin-chat-remote

`RemoteChatStore`로 HTTP 호스트의 대화·실행·제목 API에 연결합니다. UI나 로컬 실행 루프에 의존하지 않습니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.

원격 호스트와 desktop sidecar의 응답은 JSON 파싱 전에 32 MiB로 제한합니다.
오류 응답 본문은 16 KiB까지만 받습니다. SSE 프레임은 8 MiB에 프레임 헤더용 1 KiB를
더한 크기로 제한하며, 한 실행에서 받은 전체 바이트와 프레임 수는 재연결과 취소 후
journal 복구에도 이어서 계산합니다. 실행별 한도는 32 MiB와 16,384개입니다.
한도를 넘으면 본문 읽기와 호스트 실행을 취소하고 오류를 전달합니다.
