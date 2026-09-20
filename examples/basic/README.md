# basic 예시

OpenAI 모델, SQLite 저장소, 도구 실행이 결합된 가장 작은 에이전트 애플리케이션입니다. 같은 스레드의 두 턴을 이어 대화하며, 생성된 메시지가 SQLite에 영속화되고 다음 턴의 모델 입력에 병합되는 흐름을 보여줍니다.

## 실행

저장소 루트에서:

```sh
pnpm install
pnpm build
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4.1-mini"   # 모델 ID와 한도는 공식 문서를 참고해 설정하세요
export OPENAI_CONTEXT_WINDOW="1047576"
export OPENAI_MAX_OUTPUT_TOKENS="4096"
pnpm --filter @keundal/example-basic start
```

첫 실행 후 `examples/basic/keundal.sqlite` 파일에 대화가 남습니다. 파일을 지우면 새 대화가 시작됩니다.

## 구성

- `plugin-llm-openai` — OpenAI Responses API로 `llm` 서비스를 구현합니다. API 키와 모델 한도를 설정에서 받습니다.
- `plugin-store-sqlite` — 대화와 실행 기록을 SQLite 파일에 영속화합니다. `plugin-store-memory`(메모리)나 `plugin-store-indexeddb`(브라우저)로 바꿔도 에이전트 코드는 그대로 동작합니다.
- `plugin-agent-simple` — `llm`·`session`·`generation`을 조합하고 `clock` 도구 실행을 자동으로 연결합니다.

클라이언트(`src/main.ts`)는 대화 이력을 직접 유지해 매 턴 `messages`로 전달하고, 에이전트는 실행이 커밋한 생성 메시지를 `session`에서 읽어 이력에 누적합니다. 실제 애플리케이션에서는 이 역할을 UI 프런트엔드나 서버가 담당합니다.
