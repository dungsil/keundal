# @keundal/tools

`ExecutableTool`, `ToolExecutionContext`, `ToolProvider`를 정의합니다. 에이전트 루프, MCP 연결, 파일·셸 도구가 같은 계약을 사용합니다. 특정 에이전트나 도구 공급자에는 의존하지 않습니다.

도구는 JSON 객체 인자를 검증한 뒤 결과 문자열을 반환합니다. 실행에 전달한 `AbortSignal`은 실제 작업에 연결해야 합니다.
