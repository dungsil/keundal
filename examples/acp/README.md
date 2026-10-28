# ACP 에이전트 예제

큰달의 코딩 에이전트를 ACP v1 stdio로 제공합니다. ACP 클라이언트가 연 세션마다 LLM·메모리 저장소·파일 도구를 따로 조립합니다. 파일 접근은 클라이언트가 지정한 `cwd` 안으로 제한하고, 도구 실행마다 클라이언트에 승인을 요청합니다. Shell 도구는 제공하지 않습니다.

## 빌드와 실행

저장소 루트에서 실행합니다.

```sh
pnpm install
pnpm exec turbo run build --filter=@keundal/example-acp
export OPENAI_API_KEY="..."
export OPENAI_MODEL="gpt-4.1-mini"
node examples/acp/dist/main.js
```

실행 후 표준 입력으로 ACP JSON-RPC 요청을 받습니다. stdout은 프로토콜 전용이며 오류는 stderr로 보냅니다. 편집기에서는 `pnpm start` 대신 Node.js 진입점을 직접 실행해 패키지 관리자의 출력이 섞이지 않게 합니다.

ACP 클라이언트에 다음 실행 설정을 등록합니다. 필드 이름과 등록 위치는 클라이언트 문서를 따릅니다.

```json
{
  "command": "node",
  "args": ["/absolute/path/to/keundal/examples/acp/dist/main.js"],
  "env": { "OPENAI_MODEL": "gpt-4.1-mini" }
}
```

API 키는 편집기 프로세스의 환경이나 클라이언트의 비밀 설정으로 전달합니다. 저장소에 키를 기록하지 않습니다. `OPENAI_CONTEXT_WINDOW`와 `OPENAI_MAX_OUTPUT_TOKENS`로 모델 한도를 지정할 수 있습니다.

## 지원 범위와 안전

텍스트·리소스 링크 입력, 응답·추론 스트리밍, 파일 도구 상태·결과, 일회성 승인·거부와 취소를 지원합니다. 리소스 링크는 참조 정보로 전달하며 자동으로 파일을 읽거나 URL을 가져오지 않습니다. 이미지·오디오·내장 리소스, MCP 서버 주입, 세션 복원과 원격 전송은 지원하지 않습니다.

연결이 끝나면 진행 중인 실행을 취소하고 세션별 서비스를 정리합니다. 메모리 저장소이므로 프로세스를 종료하면 대화는 사라집니다. 파일 정책은 OS 샌드박스가 아닙니다. 신뢰하는 개인용 편집기에서만 실행하고 필요한 OS 격리를 별도로 적용하세요.

다른 LLM이나 저장소를 사용하려면 `createSession` 안의 조립을 바꿉니다. 어댑터 계약은 [`@keundal/acp`](../../packages/acp/README.md)를 참고하세요. 반대 방향으로 외부 에이전트를 큰달에서 실행하려면 [`@keundal/plugin-agent-acp`](../../packages/plugin-agent-acp/README.md)를 사용합니다.
