# @keundal/agent-host

주입받은 `llm`, `session`, `generation`, `agent` 서비스로 실행·제목·대화 API를 제공합니다. LLM SDK, 저장소 공급자, 기본 에이전트 구현에는 의존하지 않습니다.

```ts
import { createAgentHost } from '@keundal/agent-host'
import agentPlugin from '@keundal/plugin-agent-chat'
import openaiPlugin from '@keundal/plugin-llm-openai'
import memoryStorePlugin from '@keundal/plugin-store-memory'

const host = await createAgentHost({
  model: 'gpt-4.1-mini',
  models: [{ id: 'gpt-4.1-mini', provider: 'openai', contextWindow: 128_000, maxOutputTokens: 4_096 }],
  async setup(ctx) {
    await ctx.plugin(openaiPlugin, { apiKey: process.env.OPENAI_API_KEY! })
    await ctx.plugin(memoryStorePlugin)
  },
  mountAgent: async (ctx, config) => ctx.plugin(agentPlugin, config)
})
// 사용이 끝나면 await host.dispose()
```

`setup`과 `mountAgent`는 전달받은 컨텍스트에 플러그인을 등록합니다. 초기화 실패, 에이전트 등록 실패, 호스트 종료 시 해당 범위를 정리합니다. `host.services`는 `run`, `steer`, `cancel`, `subscribe`, `session`, `generation`, `models`, `title`을 제공합니다. 모델은 `models`에 등록한 ID만 사용할 수 있습니다.

호스트는 대화마다 실행을 하나만 허용합니다. `steer(runId, messages)`는 실행 중인 실행의 지시 대기열에 메시지를 넣고, `cancel(runId)`은 실행을 취소합니다. `subscribe(runId, { afterSequence })`는 journal을 재생한 뒤 새 기록을 이어서 전달합니다.

`mountAgent`는 모델 ID와 출력 예산만 받습니다. 도구와 반복 횟수 같은 구현별 정책은 앱의 조립 함수에서 추가합니다. 호스트는 `AgentConfig`나 공통 루프에 의존하지 않습니다.

`@keundal/agent-host/contracts`는 호스트 계약만 내보냅니다. `@keundal/agent-host/http`의 `createAgentApp(services, { token })`은 인증, 본문 크기 제한, AG-UI SSE를 제공하는 Node.js 요청 리스너입니다.

| 경로                                      | 동작                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------- |
| `POST /runs`                              | 실행을 시작하고 journal을 SSE로 전달합니다. 같은 대화에 실행이 있으면 `409`입니다. |
| `GET /runs/:runId/events?afterSequence=N` | `N` 다음의 journal을 전달합니다. 실행 중이면 새 기록을 이어서 전달합니다.          |
| `POST /runs/:runId/steer`                 | 실행 중이면 지시를 넣고 `202`, 아니면 `409`를 돌려줍니다.                          |
| `POST /runs/:runId/cancel`                | 실행을 취소합니다.                                                                 |

SSE 프레임의 `id`는 journal `sequence`입니다. 스트림을 연 뒤 연결이 끊겨도 실행은 계속됩니다. 실행을 멈추려면 `cancel`을 호출합니다. 자세한 보장 범위는 [실행 제어 문서](../../docs/run-control.md)를 참고합니다.

## 미디어 경로

`setup`이 `ctx.media`, `ctx.mediaTools`, `ctx.mediaDownload`를 등록하면 `services.media`가 생기고 아래 경로를 쓸 수 있습니다. 등록하지 않으면 `/media` 요청은 `503`입니다.

| 경로                                           | 동작                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------ |
| `GET /media/tools`                             | `yt-dlp`와 `ffmpeg`의 경로와 버전을 돌려줍니다.                          |
| `POST /media/tools/:name/install`              | 실행 파일을 내려받아 설치합니다.                                         |
| `PUT /media/tools/:name`                       | 본문의 `path`로 실행 파일 경로를 지정하고, `null`이면 지정을 해제합니다. |
| `POST /media/libraries`                        | 자료库를 만들고 `201`을 돌려줍니다.                                      |
| `POST /media/libraries/open`                   | 기존 자료库를 엽니다.                                                    |
| `GET /media/libraries/items?path=`             | 자료库의 항목 목록을 돌려줍니다.                                         |
| `GET /media/video?libraryPath=&itemId=`        | 영상 파일을 Range 요청과 함께 전송합니다. 쿼리 토큰을 받습니다.          |
| `POST /media/libraries/import`                 | 로컬 파일을 복사하거나 연결해서 가져옵니다.                              |
| `GET /media/items?libraryPath=&itemId=`        | 항목 하나를 돌려줍니다.                                                  |
| `DELETE /media/items?libraryPath=&itemId=`     | 항목을 삭제합니다. `permanent=1`이면 되돌릴 수 없습니다.                 |
| `POST /media/items/subtitles`                  | 자막 트랙을 저장합니다.                                                  |
| `POST /media/downloads`                        | 다운로드 작업을 만들고 `202`를 돌려줍니다.                               |
| `GET /media/downloads`                         | 작업 목록을 돌려줍니다.                                                  |
| `POST /media/downloads/:id/pause`              | 작업을 일시정지합니다. `resume`과 `cancel`은 같은 형식입니다.            |
| `GET /media/downloads/:id`                     | 작업이 끝날 때까지 기다렸다가 결과를 돌려줍니다.                         |
| `GET /media/downloads/events?replay=1`         | 진행률을 SSE로 전달합니다.                                               |
| `GET /media/transcription/models`              | 음성 인식 모델 목록과 설치 여부를 돌려줍니다.                            |
| `POST /media/transcription/models/:id/install` | 모델 파일을 내려받아 설치합니다.                                         |
| `POST /media/transcriptions`                   | 파일 하나를 전사하고 구간과 단어 시각을 돌려줍니다.                      |
| `POST /media/subtitles/translate`              | 자막 트랙을 번역하고 결과 트랙과 실패 수를 돌려줍니다.                   |
| `POST /media/exports/clips`                    | 클립을 내보내고 만든 파일 목록을 돌려줍니다.                             |
| `POST /media/exports/fcpxml`                   | 클립 구간으로 FCPXML 파일을 씁니다.                                      |

미디어 경로는 본문 검증에 실패하면 `400`과 함께 실패 사유를 돌려줍니다. 음성 인식이나 번역 서비스가 등록되지 않았으면 해당 경로는 `503`입니다.

환경 변수 처리와 기본 LLM·SQLite 구성은 [`@keundal/agent-runtime-node`](../agent-runtime-node/README.md)로 분리했습니다.
