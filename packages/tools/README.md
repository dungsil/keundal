# @keundal/tools

`ExecutableTool`, `ToolExecutionContext`, `ToolProvider`를 정의합니다. 에이전트 루프, MCP 연결, 파일·셸 도구가 같은 계약을 사용합니다. 특정 에이전트나 도구 공급자에는 의존하지 않습니다.

도구는 JSON 객체 인자를 검증한 뒤 결과 문자열을 반환합니다. 실행에 전달한 `AbortSignal`은 실제 작업에 연결해야 합니다.

## 지연 도구

`createDeferredToolSession()`은 허가된 도구 목록에서만 이름과 설명을 검색합니다. 검색 결과에는 JSON Schema나 실행 함수를 넣지 않습니다. 선택된 도구의 스키마는 다음 모델 요청에서만 제공하며, 같은 응답의 다른 호출은 새 도구를 실행할 수 없습니다.

세션은 한 실행에 묶입니다. `maxSearchResults`, `maxActiveTools`, `maxSchemaBytes`, `maxTotalSchemaBytes`로 검색 결과 수와 노출 스키마 크기를 제한합니다. 기본값은 각각 8개, 16개, 16 KiB, 64 KiB입니다.

실행 직전에 공급자를 다시 조회합니다. 현재 목록에 도구가 없거나 이름, 설명, 스키마가 달라졌으면 실행을 거부합니다. MCP 공급자를 사용하면 이 확인이 서버의 현재 도구 권한을 유지합니다.
