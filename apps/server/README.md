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
export KEUNDAL_SQLITE_PATH="keundal-server.sqlite"   # 선택
export PORT="8000"                                    # 선택
pnpm --filter @keundal/server start
```

저장소는 SQLite 파일(기본 `keundal-server.sqlite`)로 대화와 실행 기록을 영속화합니다. `createAgentApp()`을 직접 쓰면 임의의 cordis 컨텍스트를 HTTP 뒤에 붙일 수 있습니다.
