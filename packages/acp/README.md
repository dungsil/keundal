# @keundal/acp

Keundal 에이전트를 외부 ACP 클라이언트에 제공한다. 공식 `@agentclientprotocol/sdk` 2.1.0의 stable v1 API를 사용한다.

## API

```ts
import { createAcpAgent, createAcpStdioStream } from '@keundal/acp'

const adapter = createAcpAgent({
  async createSession({ cwd, toolApproval }) {
    // 호출자가 cwd 범위의 도구, 별도 저장소와 에이전트를 조립한다.
    // toolApproval을 에이전트의 도구 실행 설정에 반드시 연결한다.
    const backend = await assembleSession({ cwd, toolApproval })
    return {
      run: backend.agent.run.bind(backend.agent),
      dispose: () => backend.dispose()
    }
  }
})

const connection = adapter.app.connect(createAcpStdioStream())
try {
  await connection.closed
} finally {
  await adapter.dispose()
}
```

`assembleSession`은 호출자가 구현하는 조립 함수다. `createSession`은 `{ cwd, toolApproval }`을 받아 `Promise<{ run, dispose }>`를 반환한다. `run`은 `AgentService['run']` 계약을 따르고 전달받은 취소 신호에 실제 작업을 연결해야 한다. `dispose`는 백엔드가 소유한 저장소·도구·에이전트 자원을 정리한다.

어댑터 하나는 연결 하나를 소유한다. 여러 클라이언트를 받는 호스트는 연결마다 `createAcpAgent`를 호출한다. 연결 안에서는 여러 세션을 만들 수 있다. 세션마다 별도 백엔드와 `ToolApproval({ default: 'ask' })`을 생성하고, 고유한 thread ID를 유지한다. 각 턴에는 새 run ID와 사용자 메시지 ID를 부여한다. `run`에는 해당 턴의 새 사용자 메시지만 전달하므로 대화 보존은 백엔드의 세션 저장소가 담당한다. 같은 세션의 동시 prompt는 거부한다.

## 지원 범위

- `initialize`, `session/new`, `session/prompt`, `session/cancel`을 처리한다.
- 절대 경로인 `cwd`만 받는다. 비어 있지 않은 `mcpServers`는 명시적으로 거부한다.
- 기본 입력인 텍스트와 `resource_link`를 받는다. 링크는 URI·이름·설명을 텍스트 참조로 보존하며 로컬 파일이나 원격 자원을 자동으로 읽지 않는다. 이미지·오디오·내장 리소스가 섞이면 실행 전에 거부한다.
- `loadSession: false`와 이미지·오디오·내장 컨텍스트·HTTP/SSE MCP 미지원 capability를 반환한다. 세션 load/list, 모델·모드 선택은 구현하지 않는다.
- AG-UI 텍스트·추론 조각과 도구 호출·인자·결과를 ACP session update로 전달한다. 텍스트·추론의 `messageId`를 보존한다. 도구는 `pending`, `in_progress`, `completed`, `failed` 상태를 전달한다. 구조화된 결과는 `rawOutput`에 보존하고 텍스트 JSON으로 표시한다.
- `RUN_ERROR`, 백엔드 예외, `RUN_FINISHED` 없는 스트림 종료는 프로토콜 오류다. 정상 완료만 `end_turn`, 취소는 `cancelled`로 응답한다.

## 승인과 수명

`keundal.tool.approval`의 `requested` 이벤트를 받으면 ACP `session/request_permission`을 호출한다. 선택지는 `allow_once`와 `reject_once`다. 클라이언트가 `allow_once` ID를 명시적으로 선택한 경우에만 실행을 허용한다. 취소·알 수 없는 선택·통신 오류는 승인하지 않는다. 승인 이벤트의 thread/run 범위가 현재 실행과 다르면 오류로 처리한다.

`cwd` 검사는 파일 접근 권한이나 격리를 제공하지 않는다. 호출자는 허용 경로를 확인하고 cwd 범위의 파일 시스템·셸 도구를 조립해야 한다. 전달한 `toolApproval`을 사용하지 않는 도구의 실행은 이 어댑터가 통제할 수 없다. 외부 클라이언트 연결의 인증과 접근 제어도 호스트가 담당한다.

취소와 연결 종료는 진행 중 실행에 취소 신호를 전달한다. 연결 종료 또는 `dispose()`는 실행 종료를 기다린 뒤 모든 백엔드를 정리한다. 생성 중이던 백엔드도 완료되는 대로 정리한다. `dispose()`는 여러 번 호출해도 한 번만 정리하며 정리 실패를 보고한다. 실행·도구는 자동 재시도하거나 재실행하지 않는다.

`createAcpStdioStream(input?, output?)`은 Node 스트림을 SDK의 NDJSON 스트림으로 변환한다. 기본값은 `process.stdin`과 `process.stdout`이다. stdout은 JSON-RPC 전용으로 두고 진단 로그는 stderr에 기록한다. 이 패키지는 콘솔 로그를 출력하지 않는다.
