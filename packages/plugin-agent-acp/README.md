# @keundal/plugin-agent-acp

외부 ACP 에이전트를 stdio 자식 프로세스로 실행해 `ctx.agent`로 제공합니다. 공식 `@agentclientprotocol/sdk`의 안정판 ACP v1을 사용하며 기존 에이전트 루프와 LLM 호출을 거치지 않습니다. Node.js 호스트와 desktop sidecar에서 사용합니다. 브라우저 단독 실행에서는 사용할 수 없습니다.

## Node.js 호스트에서 선택

`KEUNDAL_PLUGIN_CONFIG`가 가리키는 매니페스트에서 `builtin:acp`를 선택합니다.

```json
{
  "plugins": [{ "module": "builtin:llm" }, { "module": "builtin:store" }],
  "agent": {
    "module": "builtin:acp",
    "config": {
      "command": "/absolute/path/to/acp-agent",
      "args": [],
      "cwd": "/absolute/path/to/project"
    }
  },
  "tools": []
}
```

설치한 에이전트의 ACP 실행 명령과 인증 방법을 따릅니다. 일반 채팅 CLI 실행 명령이 아니라 ACP 모드로 실행해야 합니다. 기본 호스트의 LLM은 제목 생성용으로 유지하며, 실제 답변은 외부 에이전트가 생성합니다. 호스트의 `model` 설정은 로컬 journal 메타데이터이며 외부 에이전트의 모델을 바꾸지 않습니다.

코딩 작업공간을 연결한 대화는 Worktree 경로를 `cwd`로 사용합니다. 외부 에이전트는 큰달의 파일 정책이나 Git 메타데이터 차단을 거치지 않으므로 해당 에이전트의 권한·격리 설정을 따로 확인해야 합니다.

## 직접 조립

`session`과 `generation`을 등록한 Cordis 컨텍스트에 연결합니다. 저장소가 generation 이벤트 공급자를 지원해야 합니다.

```ts
import acpAgentPlugin from '@keundal/plugin-agent-acp'
import { ToolApproval } from '@keundal/tool-approval'

const approval = new ToolApproval({ default: 'ask' })
await ctx.plugin(acpAgentPlugin, {
  command: '/absolute/path/to/acp-agent',
  cwd: '/absolute/path/to/project',
  toolApproval: approval
})
// ctx.agent.run(input, { signal })의 이벤트를 소비합니다.
// 승인 이벤트의 runId와 requestId로 approval.respond(runId, requestId, 'allow' | 'deny')를 호출합니다.
```

기본 권한은 `deny`입니다. Node.js 호스트에서는 `toolApproval` 정책이나 `KEUNDAL_TOOL_APPROVAL`을 명시한 경우에만 그 정책을 사용합니다. 승인은 ACP의 `allow_once`만 선택하며 영구 승인을 저장하지 않습니다. 요청에 일회성 허용 항목이 없으면 취소로 응답합니다. 외부 에이전트가 승인 요청 없이 직접 수행하는 작업까지 통제하지는 않습니다.

## 실행과 기록

- 대화마다 외부 프로세스와 ACP 세션을 하나씩 유지합니다. 후속 턴에는 새 사용자 메시지만 보내며, 같은 대화의 동시 실행과 이미 보낸 메시지 수정은 거부합니다.
- 텍스트·추론·도구 호출·결과는 AG-UI로 변환해 기존 generation journal과 세션에 기록합니다. ACP의 세션 범위 식별자는 실행마다 별도 AG-UI 식별자로 바꿉니다.
- 계획·Diff·사용량 등 원본 알림은 `keundal.acp.update` CUSTOM 이벤트로 보존합니다. 전용 UI 렌더러는 추가하지 않습니다.
- 실행 중 지시는 외부 ACP 턴이 끝난 안전한 경계에서 다음 프롬프트로 전달합니다. 외부 에이전트 내부의 모델·도구 반복에는 끼어들지 않습니다.
- 취소·순회 중단·플러그인 해제는 외부 프로세스를 종료합니다. 연결 오류와 실패는 자동 재시도하지 않습니다. 로컬 부분 응답과 확정된 journal은 유지합니다.
- 외부 세션이 종료되거나 호스트를 재시작하면 기존 대화를 다시 실행하지 않고 새 대화를 요구합니다. 이 제한은 파일 수정이나 명령 실행의 중복을 막습니다. 로컬 journal 재생과 조회는 계속 사용할 수 있습니다.

## 설정과 제한

`command`와 절대 경로 `cwd`는 필수입니다. `args`는 문자열 배열, `env`는 상속한 환경 변수에 덧붙일 값입니다. `connectTimeoutMs`는 초기화·세션 생성의 제한 시간이며 기본값은 30초입니다. `maxOutputTokens`의 기본값은 8192이며 로컬 generation 요청에 기록합니다. 외부 에이전트의 토큰·비용·시간 예산을 제어하지 않으므로 실행별 `budget`은 거부합니다.

현재 입력은 텍스트 사용자 메시지만 지원합니다. 시스템·개발자 메시지, 호출자 도구·컨텍스트, 멀티모달 입력은 거부합니다. 큰달의 로컬 도구와 MCP 서버는 외부 에이전트에 자동 전달하지 않습니다. 클라이언트 파일·터미널 기능은 협상에서 제공하지 않으며, 외부 에이전트의 자체 파일·Shell 기능을 사용합니다. 인증·모델·모드 변경은 외부 에이전트에서 미리 설정해야 합니다.

외부 실행 파일과 환경 변수는 호스트 권한으로 실행됩니다. 이 플러그인은 샌드박스가 아니며 신뢰하지 않는 실행 파일을 등록하면 안 됩니다. 반대 방향 연결은 [`@keundal/acp`](../acp/README.md)와 [실행 예제](../../examples/acp/README.md)를 참고하세요.
