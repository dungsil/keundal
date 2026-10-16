# Keundal

Keundal("큰달"으로 읽음)은 개인용 오픈소스 에이전트 도구입니다. Cordis 플러그인으로 조합하는 AG-UI 프로토콜 기반 에이전트 스택입니다.

## 패키지 구성

| 패키지                            | 역할                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `@keundal/core`                   | 서비스 계약, Cordis Context 확장, AG-UI 타입과 검증 기능을 제공합니다.    |
| `@keundal/plugin-agent-simple`    | 세 서비스와 대화 축약 함수를 조합하고 도구 실행과 후속 생성을 연결합니다. |
| `@keundal/plugin-llm-openai`      | OpenAI Responses API로 `llm`을 구현합니다.                                |
| `@keundal/plugin-llm-gemini`      | Gemini API로 `llm`을 구현합니다.                                          |
| `@keundal/plugin-llm-anthropic`   | Anthropic Messages API로 `llm`을 구현합니다.                              |
| `@keundal/plugin-store-memory`    | `session`과 `generation`을 메모리 저장소로 구현합니다.                    |
| `@keundal/plugin-store-indexeddb` | 브라우저의 IndexedDB로 `session`과 `generation`을 구현합니다.             |
| `@keundal/plugin-store-sqlite`    | SQLite 파일로 `session`과 `generation`을 구현합니다.                      |
| `@keundal/compaction`             | 이전 대화를 요약하고 최근 대화를 보존하는 축약 함수를 제공합니다.         |

각 패키지의 설정과 사용법은 패키지 안의 README.md를 참고하고, 저장소 규칙은 [AGENTS.md](./AGENTS.md)에 정리되어 있습니다.

## 시작하기

Node.js 24와 pnpm이 필요합니다. 버전은 루트 `package.json`의 `devEngines`를 따릅니다.

```sh
pnpm install
pnpm build
```

OpenAI 키가 있다면 바로 실행할 수 있는 예제가 준비되어 있습니다:

```sh
export OPENAI_API_KEY="sk-..."
export OPENAI_MODEL="gpt-4.1-mini"
export OPENAI_CONTEXT_WINDOW="1047576"
export OPENAI_MAX_OUTPUT_TOKENS="4096"
pnpm --filter @keundal/example-basic start
```

예제는 [examples/basic](./examples/basic/README.md)에서 도구 실행과 두 턴 대화의 이력 병합을 보여줍니다. 다른 LLM 공급자나 저장소로 바꾸는 방법도 같은 문서에 정리되어 있습니다.

## 웹 앱

[apps/web](./apps/web/README.md)은 [Nuxt UI Chat](https://github.com/nuxt-ui-templates/chat)의 화면·문구·컴포넌트·스타일과 에셋을 그대로 사용합니다. 서버의 제목 생성과 대화 요청은 기존 Keundal LLM 플러그인으로 실행하며, AI SDK는 메시지 스트림과 도구 실행을 연결합니다. 웹 소스는 원본 ESLint 설정으로 검사하고 루트 Oxfmt로 재포맷하지 않습니다.

```sh
pnpm install
pnpm --filter @keundal/web db:migrate
pnpm --filter @keundal/web dev
```

선택한 모델에 맞는 `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`를 `apps/web/.env`에 설정합니다. Nuxt 서버에서 플러그인을 직접 사용하므로 `apps/server`를 따로 실행할 필요가 없습니다. 공급자 내장 웹 검색과 추론 강도 설정은 현재 Keundal 계약에서 지원하지 않습니다. 음성 받아쓰기는 기존 AI Gateway 경로를 유지합니다. 자세한 설정과 제한은 [웹 앱 문서](./apps/web/README.md)를 참고합니다.

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)에 따라 배포됩니다.

### 크레딧

- [Cordis] - 플러그인 기반의 메타 프레임워크
- [AG-UI] - 에이전트 실행 입력과 이벤트를 정의하는 프로토콜

<!-- 링크 -->

[Cordis]: https://github.com/cordiverse/cordis
[AG-UI]: https://github.com/ag-ui-protocol/ag-ui
