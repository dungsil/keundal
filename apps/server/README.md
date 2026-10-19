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
export KEUNDAL_MAX_REQUEST_BODY_BYTES="8388608"      # 선택, 기본 8 MiB
export PORT="8000"                                    # 선택
pnpm --filter @keundal/server start
```

저장소는 SQLite 파일(기본 `keundal-server.sqlite`)로 대화와 실행 기록을 영속화합니다. `createAgentApp()`을 직접 쓰면 임의의 cordis 컨텍스트를 HTTP 뒤에 붙일 수 있습니다.

## 요청 본문 제한

`POST /runs`의 JSON 본문은 기본 **8 MiB (8,388,608 바이트)**까지 허용합니다. 기본 128k 토큰 컨텍스트의 일반적인 텍스트 입력에 메시지·도구·상태 등 JSON 부가 정보를 담을 여유를 둔 전송 상한입니다. 토큰 수와 바이트 수는 일대일 대응하지 않으며, 모든 모델의 최대 입력이나 대형 인라인 이미지까지 보장하는 값은 아닙니다. 긴 대화 이력, 큰 상태 또는 이미지 데이터를 전송한다면 배포 환경의 메모리를 고려하여 `KEUNDAL_MAX_REQUEST_BODY_BYTES`를 조정하세요. 모델 입력 토큰 예산 검사는 이 제한과 별개입니다.

직접 조합할 때는 `createAgentApp(services, { maxRequestBodyBytes: 8 * 1024 * 1024 })`로 지정합니다. 값은 양의 안전한 정수여야 하며, 잘못된 설정은 앱 생성 시 오류로 거부합니다.

`Content-Length`가 상한을 넘으면 본문을 읽기 전에 거부합니다. 헤더 유무와 관계없이 수신 청크의 실제 바이트 수도 검사하며, 상한과 같은 크기는 허용하고 초과 시 읽기를 중단합니다. UTF-8 문자열 변환·JSON 파싱·agent 실행 전에 **413**과 `{"error":"request body too large"}`를 응답하고 연결을 닫습니다. 수신 중인 초과 청크는 누적하지 않습니다. 허용된 본문에는 버퍼 병합·문자열 변환·JSON 파싱에 따른 추가 메모리가 필요하므로 이 값은 요청당 전체 메모리 상한이 아닙니다.
