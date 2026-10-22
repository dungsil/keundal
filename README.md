# Keundal

Keundal("큰달"으로 읽음)은 개인용 오픈소스 에이전트 도구입니다. Cordis 플러그인으로 조합하는 AG-UI 프로토콜 기반 에이전트 스택입니다.

## 패키지 구성

| 패키지                                 | 역할                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `@keundal/core`                        | 서비스 계약, Cordis Context 확장, AG-UI 타입과 검증 기능을 제공합니다. |
| `@keundal/agent-host`                  | Node.js에서 에이전트 서비스와 플러그인을 조립합니다.                   |
| `@keundal/agent`                       | 교체 가능한 에이전트 서비스 계약을 제공합니다.                         |
| `@keundal/agent-loop`                  | 에이전트가 공유하는 실행 루프와 설정을 제공합니다.                     |
| `@keundal/plugin-agent-chat`           | 공통 루프로 대화 에이전트를 등록합니다.                                |
| `@keundal/plugin-agent-coding`         | 공통 루프에 코딩 지침을 적용한 에이전트를 등록합니다.                  |
| `@keundal/tools`                       | 에이전트와 공급자가 공유하는 도구 실행 계약을 제공합니다.              |
| `@keundal/context`                     | 요청 컨텍스트와 파일·세션 참조의 계약을 제공합니다.                    |
| `@keundal/plugin-context`              | 공급자를 조합하여 요청 컨텍스트를 준비합니다.                          |
| `@keundal/plugin-context-node`         | 로컬 파일·작업 지침·tmux 컨텍스트를 제공합니다.                        |
| `@keundal/plugin-skill`                | 스킬 공급자를 조합하고 목록 조회와 본문 로딩을 제공합니다.             |
| `@keundal/plugin-skill-filesystem`     | 지정한 디렉터리의 `SKILL.md`를 스킬 공급자로 등록합니다.               |
| `@keundal/mcp`                         | SDK와 무관한 MCP 설정 계약과 검증을 제공합니다.                        |
| `@keundal/plugin-mcp-client`           | 외부 MCP 서버의 도구와 리소스를 에이전트 도구에 연결합니다.            |
| `@keundal/plugin-llm-openai`           | OpenAI Responses API로 `llm`을 구현합니다.                             |
| `@keundal/plugin-llm-gemini`           | Gemini API로 `llm`을 구현합니다.                                       |
| `@keundal/plugin-llm-anthropic`        | Anthropic Messages API로 `llm`을 구현합니다.                           |
| `@keundal/plugin-transcription-openai` | OpenAI 실시간 받아쓰기 자격 증명과 브라우저 전송을 제공합니다.         |
| `@keundal/plugin-store-memory`         | `session`과 `generation`을 메모리 저장소로 구현합니다.                 |
| `@keundal/plugin-store-indexeddb`      | 브라우저의 IndexedDB로 `session`과 `generation`을 구현합니다.          |
| `@keundal/plugin-store-sqlite`         | SQLite 파일로 `session`과 `generation`을 구현합니다.                   |
| `@keundal/compaction`                  | 이전 대화를 요약하고 최근 대화를 보존하는 축약 함수를 제공합니다.      |
| `@keundal/fs`                          | 파일 공급자와 정책이 공유하는 `ctx.fs` 계약을 제공합니다.              |

각 패키지의 설정과 사용법은 패키지 안의 README.md를 참고하고, 저장소 규칙은 [AGENTS.md](./AGENTS.md)에 정리되어 있습니다.

## 파일과 Shell 도구

`@keundal/fs`의 `FileSystemService`는 `ctx.fs`의 공통 계약입니다.
`ShellService`와 `ctx.shell`의 타입 확장은 `@keundal/shell`에서 제공합니다.
실행 공급자와 모델에 노출할 도구는 별도 플러그인으로 연결합니다.

교체 가능한 서비스는 계약과 구현을 분리하며 앱에서 사용할 구현을 선택합니다.
fs는 로컬 공급자와 정책 구현이 계약을 공유하므로 처음부터 별도 계약 패키지를 사용합니다.
`TranscriptionService`와 `ctx.transcription`의 타입 확장은 `@keundal/transcription`에서 제공합니다.

- [plugin-fs-local](packages/plugin-fs-local/README.md)은 Node.js 파일 접근을 구현합니다.
- [plugin-fs-policy](packages/plugin-fs-policy/README.md)는 경로·수정 권한과 대화별 읽기 기록을 검사합니다.
- [plugin-tool-fs](packages/plugin-tool-fs/README.md)는 읽기·목록·쓰기·편집 도구를 제공합니다.
- [plugin-shell-local](packages/plugin-shell-local/README.md)은 전경 명령과 취소·시간·출력 한도·프로세스 종료를 관리합니다.
- [plugin-tool-shell](packages/plugin-tool-shell/README.md)은 Shell 도구를 제공합니다.

파일 정책과 Shell의 작업 디렉터리 검사는 OS 샌드박스가 아닙니다.
Shell 명령은 파일 정책을 거치지 않습니다. 신뢰할 수 없는 실행에는 OS 격리를 적용하십시오.
Node.js 공급자 대신 Tauri IPC나 원격 서버 공급자를 연결할 수 있습니다. 앱의 자동 도구 등록은 포함하지 않습니다.

## Execution Trace와 Deferred Tools

공통 에이전트 루프는 모델 호출, 도구 실행, Compaction을 같은 실행의 Trace로 연결합니다. 공용 Chat UI에서 실행 단계, 타임라인, 토큰·캐시·시간과 알려진 비용을 조회합니다. Trace는 기존 Generation Journal의 버전이 있는 메타데이터로 저장합니다.

MCP 도구가 많으면 Deferred Tools를 선택하여 검색한 도구의 Schema만 후속 모델 요청에 노출합니다. 직접 등록한 기본 도구와 MCP 권한은 유지합니다. 데이터 계약, 검색 한도, 사용 방법과 검증 결과는 [실행 관측 문서](docs/execution-trace.md)를 참고합니다.

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

[apps/web](./apps/web/README.md)은 [Nuxt UI Chat](https://github.com/nuxt-ui-templates/chat)의 화면·컴포넌트·스타일과 에셋을 사용합니다. 제목·대화·도구 실행·웹 검색·추론·받아쓰기는 Keundal 플러그인으로 실행하며 대화·이미지·실행 journal은 `plugin-store-indexeddb`로 브라우저에 저장합니다. 채팅 상태·표시 메시지·스트림 처리는 프로젝트 내부에서 Cordis·AG-UI 기반으로 구현하며 Vercel AI SDK에 의존하지 않습니다. 웹 소스의 JavaScript·TypeScript와 Vue 스크립트는 루트 Oxlint 설정으로 검사하고 루트 Oxfmt로 재포맷하지 않습니다.

```sh
pnpm install
pnpm --filter @keundal/web dev
```

선택한 모델에 맞는 `OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`를 `apps/web/.env`에 설정합니다. 받아쓰기는 별도로 OpenAI 키와 로그인이 필요합니다. AI Gateway·D1·R2는 필요하지 않습니다. Node.js에서는 웹 앱에 통합된 에이전트 API를 선택해 사용할 수 있습니다. 로컬 대화는 계정/기기 간 동기화되지 않으며 공개 공유는 비활성화합니다. 저장소 교체 계약과 Cloudflare 배포 방법은 [웹 앱 문서](./apps/web/README.md)를 참고합니다.

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

플랫폼별 구현 선택과 계약 패키지의 경계는 [플러그인 조립 문서](docs/plugin-composition.md)를 따릅니다. 공통 UI와 계약 패키지는 구현 플러그인에 실행 의존성을 추가하지 않습니다.
