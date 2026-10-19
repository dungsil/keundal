# @keundal/server

keundal 에이전트를 HTTP로 노출하는 실행 가능한 서버입니다. AG-UI 실행은 SSE로 스트리밍하고, 스레드·실행 조회와 복구는 JSON API로 제공합니다.

## 라우트

| 라우트             | 설명                                                                      |
| ------------------ | ------------------------------------------------------------------------- |
| `POST /runs`       | 본문으로 `RunAgentInput` JSON을 받아 AG-UI 이벤트를 SSE로 스트리밍합니다. |
| `GET /threads`     | 저장된 모든 스레드 스냅숏을 돌려줍니다.                                   |
| `GET /threads/:id` | 한 스레드의 스냅숏을 돌려줍니다.                                          |
| `GET /runs`        | 저장된 모든 실행 스냅숏을 돌려줍니다.                                     |
| `GET /runs/:id`    | 한 실행의 스냅숏을 돌려줍니다.                                            |
| `POST /recover`    | 미완료 실행을 interrupted로 확정하고 결과를 돌려줍니다.                   |

실행 중 오류가 나면 SSE 스트림을 `RUN_ERROR` 이벤트로 마칩니다.

## 실행

```sh
export OPENAI_API_KEY="sk-..."        # 또는 GEMINI_API_KEY, ANTHROPIC_API_KEY
export KEUNDAL_MODEL="gpt-4.1-mini"
export KEUNDAL_CONTEXT_WINDOW="1047576"
export KEUNDAL_MAX_OUTPUT_TOKENS="4096"
export KEUNDAL_API_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
export KEUNDAL_SQLITE_PATH="keundal-server.sqlite"   # 선택
export PORT="8000"                                    # 선택
pnpm --filter @keundal/server start
```

저장소는 SQLite 파일(기본 `keundal-server.sqlite`)로 대화와 실행 기록을 영속화합니다.

## 인증과 네트워크 경계

이 서버는 **단일 사용자용**입니다. 토큰을 가진 호출자는 모든 대화·실행 기록을 조회하고, 운영자의 모델 API 키로 생성을 실행하거나 복구할 수 있습니다. 사용자별 소유권 분리는 제공하지 않으며, 웹 앱의 GitHub 로그인과도 별개입니다.

- 모든 경로에서 `Authorization: Bearer <토큰>` 헤더가 필요합니다. 인증 누락·불일치는 JSON `401`과 `WWW-Authenticate: Bearer`로 응답하며, 요청 본문이나 저장소·에이전트를 처리하지 않습니다. URL 쿼리에 토큰을 넣지 마세요.
- `KEUNDAL_API_TOKEN`은 필수이며, 누락·빈 값·공백 또는 잘못된 Bearer 토큰 형식이면 시작하지 않습니다. 무인증 모드는 없습니다. 위 명령처럼 충분히 긴 난수 토큰을 생성하고 클라이언트에도 안전하게 전달하세요. 모델 공급자의 API 키와는 다른 값입니다. 재시작 후 같은 토큰을 사용하려면 비밀 저장소에서 주입하세요.
- 기본 바인딩은 `127.0.0.1:8000`입니다. 다른 인터페이스를 사용하려면 `KEUNDAL_HOST`를 명시하세요(예: IPv6 loopback `::1`, 모든 IPv4 인터페이스 `0.0.0.0`). 빈 주소는 거부합니다. 컨테이너 포트 게시가 필요할 때도 명시적으로 설정해야 합니다.
- 외부 공개 시 TLS를 제공하는 신뢰할 수 있는 리버스 프록시와 방화벽을 사용하세요. Bearer 토큰은 HTTP 평문 연결에서 보호되지 않습니다. 프록시는 Authorization 헤더와 SSE 스트리밍을 전달해야 하며, 토큰을 로그·소스 코드에 남기지 마세요. loopback 바인딩도 로컬 프로세스의 접근을 인증하는 대신이 아닙니다.

기존 클라이언트는 모든 요청에 헤더를 추가해야 합니다. 예를 들어 같은 셸에서 실행한다면:

```sh
curl --fail -H "Authorization: Bearer $KEUNDAL_API_TOKEN" http://127.0.0.1:8000/threads
curl --fail --no-buffer http://127.0.0.1:8000/runs \
  -H "Authorization: Bearer $KEUNDAL_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"threadId":"example","runId":"run-1","state":{},"tools":[],"context":[],"messages":[{"id":"q1","role":"user","content":"안녕하세요"}]}'
```

`createAgentApp()`을 직접 쓰면 임의의 cordis 컨텍스트를 HTTP 뒤에 붙일 수 있습니다. 이 경우에도 `createAgentApp(services, { token: process.env.KEUNDAL_API_TOKEN ?? '' })`처럼 두 번째 인자로 토큰을 반드시 전달해야 하며, 바인딩 주소는 호출자가 명시적으로 제한해야 합니다. 기존 `createAgentApp(services)` 호출은 더 이상 허용되지 않습니다.
