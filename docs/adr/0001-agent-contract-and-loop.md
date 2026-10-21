# 에이전트 계약과 공통 루프를 분리한다

`agent`는 `ctx.agent` 계약만 소유하고, `agent-loop`는 재사용하는 실행 루프와 설정을 소유한다. 대화·코딩 구현은 각각 `plugin-agent-chat`과 `plugin-agent-coding`에 둔다. 공통 루프를 대화 플러그인 안에 두는 안은 코딩 구현이 채팅 구현에 의존하게 하므로 사용하지 않는다.
