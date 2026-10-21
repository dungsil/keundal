# @keundal/agent

`AgentService`와 `ctx.agent`의 계약을 제공합니다. 독립적인 구현은 `AgentService.run()`을 구현합니다. 기본 실행 루프나 그 설정을 따를 필요는 없습니다.

공통 루프와 `AgentConfig`는 `@keundal/agent-loop`에 둡니다. 대화 구현은 `@keundal/plugin-agent-chat`, 코딩 구현은 `@keundal/plugin-agent-coding`이 등록합니다. 도구 계약은 `@keundal/tools`에서 가져옵니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
