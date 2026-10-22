# @keundal/chat

채팅 메시지, 대화 저장소와 `ChatPlatform` 계약, 모델 식별자, 스킬 설정과 도구 표시 스키마를 제공합니다. Cordis, Tauri, LLM SDK와 저장소 구현에는 의존하지 않습니다. 구현별 연결은 각 앱에서 조립합니다.

공급자 설정은 `@keundal/llm-settings`, 스킬 관리는 `@keundal/plugin-chat-browser/skills`, 날씨와 차트 도구 실행은 `@keundal/plugin-tool-chat`이 제공합니다.

`ChatStoreLike.getRun(runId)`는 알려진 실행 ID 하나의 저널과 상태를 가져옵니다. 실행 전체를 나열하지 않으므로 UI는 대화 메시지의 실행 ID로 필요한 기록만 조회합니다.

`ChatStoreLike.branch(sourceId, messageId, newId)`는 선택한 사용자·어시스턴트 메시지까지 복사한 새 대화를 만들고 원래 대화는 바꾸지 않습니다. 실행 중에도 호출할 수 있으며, 두 저장소 구현은 `branchChat()`의 같은 복사 규칙을 씁니다. 규칙은 [대화 분기](../../docs/chat-branch.md)를 참고합니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
