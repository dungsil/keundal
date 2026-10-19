# Keundal

Keundal("큰달"으로 읽음)은 개인용 오픈소스 에이전트 도구입니다. Cordis 플러그인으로 조합하는 AG-UI 프로토콜 기반 에이전트 스택입니다.

## 패키지 구성

| 패키지                                 | 역할                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `@keundal/core`                        | 서비스 계약, Cordis Context 확장, AG-UI 타입과 검증 기능을 제공합니다.    |
| `@keundal/plugin-agent-simple`         | 세 서비스와 대화 축약 함수를 조합하고 도구 실행과 후속 생성을 연결합니다. |
| `@keundal/plugin-skill`                | 스킬 공급자를 조합하고 목록 조회와 본문 로딩을 제공합니다.                |
| `@keundal/plugin-skill-filesystem`     | 지정한 디렉터리의 `SKILL.md`를 스킬 공급자로 등록합니다.                  |
| `@keundal/mcp`                         | 외부 MCP 서버의 도구와 리소스를 기존 에이전트 도구에 연결합니다.          |
| `@keundal/plugin-llm-openai`           | OpenAI Responses API로 `llm`을 구현합니다.                                |
| `@keundal/plugin-llm-gemini`           | Gemini API로 `llm`을 구현합니다.                                          |
| `@keundal/plugin-llm-anthropic`        | Anthropic Messages API로 `llm`을 구현합니다.                              |
| `@keundal/plugin-transcription-openai` | OpenAI 실시간 받아쓰기 자격 증명과 브라우저 전송을 제공합니다.            |
| `@keundal/plugin-store-memory`         | `session`과 `generation`을 메모리 저장소로 구현합니다.                    |
| `@keundal/plugin-store-indexeddb`      | 브라우저의 IndexedDB로 `session`과 `generation`을 구현합니다.             |
| `@keundal/plugin-store-sqlite`         | SQLite 파일로 `session`과 `generation`을 구현합니다.                      |
| `@keundal/compaction`                  | 이전 대화를 요약하고 최근 대화를 보존하는 축약 함수를 제공합니다.         |
| `@keundal/fs`                          | 파일 공급자와 정책이 공유하는 `ctx.fs` 계약을 제공합니다.                 |

각 패키지의 설정과 사용법은 패키지 안의 README.md를 참고하고, 저장소 규칙은 [AGENTS.md](./AGENTS.md)에 정리되어 있습니다.

## 파일과 Shell 도구

`@keundal/fs`의 `FileSystemService`는 `ctx.fs`의 공통 계약입니다.
`ShellService`와 `ctx.shell`의 타입 확장은 `@keundal/plugin-shell-local`에서 제공합니다.
실행 공급자와 모델에 노출할 도구는 별도 플러그인으로 연결합니다.

구현이 하나뿐인 기능은 계약과 구현을 같은 패키지에 둡니다. 두 번째 구현이 생기면 계약 패키지를 분리합니다.
fs는 로컬 공급자와 정책 구현이 계약을 공유하므로 처음부터 별도 계약 패키지를 사용합니다.
`TranscriptionService`와 `ctx.transcription`의 타입 확장은 `@keundal/plugin-transcription-openai`에서 제공합니다.

- [plugin-fs-local](packages/plugin-fs-local/README.md)은 Node.js 파일 접근을 구현합니다.
- [plugin-fs-policy](packages/plugin-fs-policy/README.md)는 경로·수정 권한과 대화별 읽기 기록을 검사합니다.
- [plugin-tool-fs](packages/plugin-tool-fs/README.md)는 읽기·목록·쓰기·편집 도구를 제공합니다.
- [plugin-shell-local](packages/plugin-shell-local/README.md)은 전경 명령과 취소·시간·출력 한도·프로세스 종료를 관리합니다.
- [plugin-tool-shell](packages/plugin-tool-shell/README.md)은 Shell 도구를 제공합니다.

파일 정책과 Shell의 작업 디렉터리 검사는 OS 샌드박스가 아닙니다.
Shell 명령은 파일 정책을 거치지 않습니다. 신뢰할 수 없는 실행에는 OS 격리를 적용하십시오.
Node.js 공급자 대신 Tauri IPC나 원격 서버 공급자를 연결할 수 있습니다. 앱의 자동 도구 등록은 포함하지 않습니다.

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

[apps/web](./apps/web/README.md)은 [Nuxt UI Chat](https://github.com/nuxt-ui-templates/chat)의 화면·컴포넌트·스타일과 에셋을 사용합니다. 제목·대화·도구 실행·웹 검색·추론·받아쓰기는 Keundal 플러그인으로 실행하며 대화·이미지·실행 journal은 `plugin-store-indexeddb`로 브라우저에 저장합니다. 채팅 상태·표시 메시지·스트림 처리는 프로젝트 내부에서 Cordis·AG-UI 기반으로 구현하며 Vercel AI SDK에 의존하지 않습니다. 웹 소스는 원본 ESLint 설정으로 검사하고 루트 Oxfmt로 재포맷하지 않습니다.

```sh
pnpm install
pnpm --filter @keundal/web dev
```

선택한 모델에 맞는 `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`를 `apps/web/.env`에 설정합니다. 받아쓰기는 별도로 OpenAI 키와 로그인이 필요합니다. `apps/server`·AI Gateway·D1·R2는 필요하지 않습니다. 로컬 대화는 계정/기기 간 동기화되지 않으며 공개 공유는 비활성화합니다. 저장소 교체 계약과 Cloudflare 배포 방법은 [웹 앱 문서](./apps/web/README.md)를 참고합니다.

## 데스크톱 앱

[apps/desktop](./apps/desktop/README.md)은 웹 앱의 UI를 공유하는 Tauri 2 앱입니다. 정적 UI를 앱에 포함하므로 별도 웹 서버 없이 실행하며, API 키는 앱의 **LLM settings**에서 입력합니다. Rust와 [운영체제별 Tauri 빌드 도구](https://v2.tauri.app/start/prerequisites/)가 필요합니다.

```sh
pnpm build
pnpm --filter @keundal/desktop dev
# 현재 OS용 설치 파일 생성
pnpm --filter @keundal/desktop bundle
```

## 라이선스

이 프로젝트는 [MIT License](./LICENSE)에 따라 배포됩니다.

### 크레딧

- [Cordis] - 플러그인 기반의 메타 프레임워크
- [AG-UI] - 에이전트 실행 입력과 이벤트를 정의하는 프로토콜

<!-- 링크 -->

[Cordis]: https://github.com/cordiverse/cordis
[AG-UI]: https://github.com/ag-ui-protocol/ag-ui
