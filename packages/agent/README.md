# @keundal/agent

`AgentService`와 `ctx.agent`의 계약을 제공합니다. 독립적인 구현은 `AgentService.run()`을 구현합니다. 기본 실행 루프나 그 설정을 따를 필요는 없습니다.

`inputCapabilities.systemMessages`는 시스템 메시지 지원 여부이며 기본값은 `true`입니다. ACP처럼 시스템 지침을 받을 수 없는 구현은 `false`로 선언합니다. 일반 채팅은 `forwardedProps.keundalChatInstructions`의 `defaults`에 앱 기본 지침을, `custom`에 사용자 지침을 구분해 전달합니다. 로컬 채팅과 호스트는 선택한 에이전트의 지원 범위에 맞춰 `prepareChatInput()`으로 실행 입력을 만듭니다. 시스템 메시지를 지원하면 두 지침을 합치고, 지원하지 않으면 기본 지침만 생략합니다. 공백이 아닌 사용자 지침은 지원 불가 오류로 알리며 사용자 메시지로 바꾸거나 조용히 버리지 않습니다. 직접 전달한 시스템·개발자 메시지는 이 함수가 제거하지 않습니다.

공통 루프와 `AgentConfig`는 `@keundal/agent-loop`에 둡니다. 대화 구현은 `@keundal/plugin-agent-chat`, 코딩 구현은 `@keundal/plugin-agent-coding`이 등록합니다. 도구 계약은 `@keundal/tools`에서 가져옵니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
