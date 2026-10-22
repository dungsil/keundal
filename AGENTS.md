# Repository Guidelines

## 패키지 구성

| 패키지                                 | 역할                                                                       |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `@keundal/ui`                          | 웹 UI의 공통 Vue 컴포넌트를 Nuxt 레이어로 제공합니다.                      |
| `@keundal/chat-app`                    | web과 desktop이 공유하는 채팅 화면과 실행 코드를 Nuxt 레이어로 제공합니다. |
| `@keundal/core`                        | 서비스 계약, Cordis Context 확장, AG-UI 타입과 검증 기능을 제공합니다.     |
| `@keundal/agent-host`                  | 주입받은 LLM·저장소·에이전트로 호스트와 HTTP 계층에 서비스를 제공합니다.   |
| `@keundal/agent`                       | 교체 가능한 에이전트 서비스 계약을 제공합니다.                             |
| `@keundal/agent-loop`                  | 공통 실행 루프와 축약·도구 반복 설정을 제공합니다.                         |
| `@keundal/plugin-agent-chat`           | 공통 루프로 대화 에이전트를 등록합니다.                                    |
| `@keundal/plugin-agent-coding`         | 공통 루프에 코딩 지침을 적용하여 에이전트를 등록합니다.                    |
| `@keundal/tools`                       | 에이전트와 도구 공급자가 공유하는 실행 계약을 제공합니다.                  |
| `@keundal/plugin-llm-openai`           | OpenAI Responses API로 `llm`을 구현합니다.                                 |
| `@keundal/plugin-llm-gemini`           | Gemini API로 `llm`을 구현합니다.                                           |
| `@keundal/plugin-llm-anthropic`        | Anthropic Messages API로 `llm`을 구현합니다.                               |
| `@keundal/plugin-store-memory`         | `session`과 `generation`을 메모리 저장소로 구현합니다.                     |
| `@keundal/compaction`                  | 이전 대화를 요약하고 최근 대화를 보존하는 축약 함수를 제공합니다.          |
| `@keundal/plugin-store-indexeddb`      | 브라우저의 IndexedDB로 `session`과 `generation`을 구현합니다.              |
| `@keundal/plugin-store-sqlite`         | SQLite 파일로 `session`과 `generation`을 구현합니다.                       |
| `@keundal/tsconfig`, `@keundal/tsdown` | 공통 TypeScript·빌드 설정을 제공합니다.                                    |

서비스 계약은 `packages/core/src/{llm,session,generation,compaction}.ts`에 정의하고, 구체 구현은 플러그인으로 주입합니다. 저장소가 공유하는 대화 병합과 실행 메시지 조립은 `packages/core/src/messages.ts`에 둡니다. AG-UI 타입, 이벤트 상수, 검증 기능은 `@keundal/core`에서 가져옵니다. `@ag-ui/core` 직접 의존은 코어의 프로토콜 래퍼에서만 관리합니다.

기능 서비스의 계약과 Cordis Context 확장은 해당 기능 패키지에서 관리합니다.
`FileSystemService`는 `@keundal/fs`에 두고 로컬 공급자와 정책 구현이 공유합니다.
`ShellService`는 `@keundal/shell`에, `TranscriptionService`는 `@keundal/transcription`에 둡니다.
교체 가능한 서비스의 계약은 구현과 분리합니다. 소비자는 계약에 의존하고 앱에서 구현을 조립합니다.

플러그인 설정과 사용법은 [공통 루프 문서](packages/agent-loop/README.md), [대화 에이전트 문서](packages/plugin-agent-chat/README.md), [코딩 에이전트 문서](packages/plugin-agent-coding/README.md), [OpenAI 문서](packages/plugin-llm-openai/README.md), [Gemini 문서](packages/plugin-llm-gemini/README.md), [Anthropic 문서](packages/plugin-llm-anthropic/README.md), [메모리 저장소 문서](packages/plugin-store-memory/README.md), [축약 문서](packages/compaction/README.md), [IndexedDB 저장소 문서](packages/plugin-store-indexeddb/README.md), [SQLite 저장소 문서](packages/plugin-store-sqlite/README.md)를 참고합니다.

## 앱 의존성 경계

`apps/*`는 `packages/*`의 공용 패키지와 Nuxt 레이어를 사용하며, 다른 앱을 의존하거나 상속하지 않습니다. `packages/*`도 앱을 참조하지 않습니다. 앱 간에 공유하는 채팅 화면과 실행 코드는 `@keundal/chat-app`에 두고, 공통 표시 컴포넌트는 `@keundal/ui`에 둡니다. 앱별 실행·배포 설정은 각 앱에서 관리합니다.

`pnpm check:boundaries`는 워크스페이스 의존성 선언, 소스 참조, Nuxt 상속과 스크립트의 앱 참조를 검사합니다. 이 검사는 `pnpm lint`와 CI에서도 실행합니다.

## 서비스 계약

- `llm`은 모델 한도 조회, 입력 토큰 계산, 공급자 스트림 호출을 담당합니다. 실행 수명 이벤트와 대화 저장은 담당하지 않습니다.
- `session.prepare()`는 원본을 변경하지 않고 생성 입력과 기준 revision을 준비하며, `threadId`와 `runId`를 유지합니다.
- `session.commit()`은 기준 revision을 검사합니다. 생성 종료 기록을 받으면 메시지·journal·종료 상태를 한 단위로 확정하고 중복 반영을 방지합니다.
- `@keundal/compaction`의 `compact()`는 원본을 보존하면서 입력 예산에 맞춰 축약한 메시지, 요약, 요약에 반영한 메시지 ID를 반환합니다.
- `generation`은 실행·journal·커밋·복구를 담당하며, 성공한 `RUN_FINISHED`는 커밋 이후에 전달합니다. 내구성이 필요한 저장소는 커밋의 영속성을 보장해야 합니다.
- `generation.run()`은 `GenerationOptions.stream`이 있으면 해당 이벤트 공급자에 취소 신호를 전달하여 실행합니다. 함수는 실행 요청과 분리하며 저장하거나 복구 시 재호출하지 않습니다.
- `generation.recover()`는 저장된 부분 응답과 확정된 종료 상태를 보존하고, 미완료 실행을 `interrupted`로 확정합니다. LLM을 다시 호출하거나 자동 재시도하지 않습니다.
- `generation.subscribe()`는 `afterSequence` 다음의 journal을 재생하고 실행 중이면 새 기록을 이어서 전달합니다. 실행을 다시 시작하지 않으며, 살아 있는 실행의 재구독과 `recover()`의 복구는 서로 다른 기능입니다.
- 실행 중 지시는 `ExecutionOptions.steer`의 `SteerQueue`로 전달하고, 에이전트는 다음 모델 요청 전의 안전한 경계에서만 반영합니다. Queue·Steer·재구독의 규칙은 [실행 제어 문서](docs/run-control.md)를 따릅니다.
- 각 서비스는 취소 신호를 실제 작업에 연결하고 자원을 정리해야 합니다.

## 에이전트 조합

`@keundal/agent`는 `AgentService`와 `ctx.agent`의 계약만 제공합니다. `@keundal/agent-loop`는 공통 루프와 `AgentConfig`를 소유하며 `@keundal/compaction`을 직접 호출합니다. `@keundal/plugin-agent-chat`은 `llm`, `session`, `generation`을 주입받아 이 루프를 등록합니다. 축약 설정은 `compaction` 옵션으로 전달합니다. `ctx.agent.run(input, { signal })`은 AG-UI `RunAgentInput`을 받아 `AsyncIterable<AGUIEvent>`를 반환합니다.

세션 입력을 준비한 뒤 컨텍스트 한도에서 출력 예산과 `reserveTokens`를 뺀 크기와 입력 크기를 비교합니다. `threshold`에 도달하면 백그라운드에서 축약을 준비하고, 예산을 넘으면 준비 결과를 기다리거나 동기 축약합니다. 준비 결과는 원본 메시지와 메타데이터가 일치할 때만 적용하고 추가 메시지를 보존하며 최신 토큰 수를 검사합니다. `compaction.models`로 모델별 정책을 재정의하고 `keepRecentTokens`로 최근 대화의 최소 보존 토큰 수를 지정합니다. 공급자의 컨텍스트 초과 오류는 해당 모델 요청의 첫 응답 이벤트 전에만 축약 후 한 번 재시도하며, 부분 응답과 완료된 도구는 다시 실행하지 않습니다. 축약 후에도 예산을 넘으면 생성을 시작하지 않습니다. 준비된 입력·revision·축약 결과는 `generation.run()`에 전달하고, 반환된 이벤트를 그대로 전달합니다. 준비 오류는 순회 중 예외로 전달합니다.

에이전트의 `tools` 설정은 도구 정의와 실행 함수를 함께 받습니다. 도구 호출을 수집하고 실행 결과를 후속 요청에 넣는 전체 과정은 하나의 generation 실행으로 기록합니다. 후속 요청에도 입력 예산 검사를 적용하며, `maxToolRounds`의 기본값은 8입니다. 도구를 등록하지 않으면 기존의 단일 생성 동작을 유지합니다.

플러그인 해제와 순회 중단은 준비·생성 작업을 취소합니다. 주입된 서비스를 교체하면 Cordis가 조합 플러그인의 수명을 갱신하며, 서비스별 격리는 `ctx.isolate('llm')`을 사용합니다.

공통 루프를 재사용하는 구현은 `@keundal/agent-loop`의 `Agent`를 상속하고 `registerAgent()`에 구현 클래스를 넘깁니다. `@keundal/plugin-agent-coding`도 이 방식으로 같은 `ctx.agent`를 구성하며 대화 플러그인에는 의존하지 않습니다. 독립적인 구현은 `@keundal/agent`의 `AgentService`를 직접 구현합니다. 도구 계약은 `@keundal/tools`에 두고, 앱이 도구 공급자를 선택합니다.

## 앱의 호스트 실행

`apps/web`의 Nitro API와 `apps/desktop`의 sidecar는 `@keundal/agent-runtime-node`에서 호스트를 조립합니다. 공통 HTTP 계약은 `@keundal/agent-host/http`에 두고, 환경 변수로 호스트와 요청 리스너를 조립하는 기능은 `@keundal/agent-runtime-node`에 둡니다. 웹은 `/api/agent/**`에서 요청을 처리하고 Nitro 종료 때 호스트를 정리합니다. 데스크톱의 프로세스 진입점과 번들은 `apps/desktop/sidecar`와 `dist-sidecar`에 둡니다. 데스크톱 호스트는 웹 서버에 의존하지 않습니다.

## 개발과 검증

Node.js와 pnpm 버전은 루트 `package.json`의 `devEngines`를 따릅니다.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

- Node.js 패키지는 `@keundal/tsconfig/node.json`과 `@keundal/tsdown`을 사용합니다. IndexedDB 플러그인은 브라우저 대상 빌드 설정과 DOM 타입을 사용합니다.
- 테스트는 각 패키지의 `tests/*.test.ts`에 작성하고 공개 진입점을 사용합니다. Turbo가 테스트 전에 패키지를 빌드합니다.
- 테스트 케이스(`test`, `it`)와 그룹(`describe`) 이름은 한국어로 작성합니다. 케이스 이름은 실제로 검증하는 조건과 기대 동작을 드러내며, 코드 식별자와 프로토콜 값은 원문을 유지합니다.
- `typecheck`는 `tsconfig.test.json`으로 테스트 코드까지 검사합니다.
- CI 환경과 의존성 설치는 `pnpm/setup`으로 처리하며, 버전은 루트 `package.json`의 `devEngines`를 따릅니다. CI 구성과 액션 검토 근거는 `docs/ci.md`를 참고합니다.

커밋, 이슈, PR을 만들 때는 [CONTRIBUTING.md](CONTRIBUTING.md)를 따릅니다.

## Agent skills

### Korean repository text

한국어 문서, 커밋 메시지, 이슈, PR, 리뷰 또는 댓글의 초안을 쓰기 전에 설치된 `vibe-docs` 스킬을 읽고 `필수 적용 순서`를 따른다. `CONTEXT.md`, 이 글의 주제를 다루는 ADR, `docs/agents/`에 정의된 도메인 용어와 라벨 문자열은 원래 표기를 그대로 유지한다.

### Issue tracker

이슈와 PRD는 GitHub Issues에서 관리하고 `gg` CLI를 사용한다. 자세한 내용은 `docs/agents/issue-tracker.md`를 읽는다.

### Triage labels

트리아지 상태는 `상태:`, 계획과 결정 유형은 `유형:` 라벨로 구분한다. `wontfix`는 `상태:수정안함`, `task`는 `유형:작업`을 쓴다. 자세한 내용은 `docs/agents/triage-labels.md`를 읽는다.

### Domain docs

단일 컨텍스트다. 루트 `CONTEXT.md`와 `docs/adr/`를 사용한다. 자세한 내용은 `docs/agents/domain.md`를 읽는다.

## Commit Message Convention

<!-- Adapted from https://www.conventionalcommits.org/en/v1.0.0/ (Conventional Commits contributors, CC BY 3.0: https://creativecommons.org/licenses/by/3.0/). Korean project-specific rules were added. -->

- Conventional Commits 형식을 따릅니다: `<type>(<scope>): <subject>`
- 사용 가능한 `type`은 `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `ci`, `chore`, `revert`입니다.
- `subject`는 한국어 평서문으로 작성하고, 80자 이내로 제한하며, 끝에 마침표를 찍지 않습니다.
- `scope`는 선택 사항입니다. 영문 소문자로 모듈이나 도메인 이름을 사용합니다(예: `auth`, `api`, `ui`).
- 커밋 제목에는 이슈 번호를 포함하지 않습니다.
- `body`에는 파일 목록이 아니라 변경이 필요한 이유(WHY)를 설명하고, 줄당 120자 이내로 줄바꿈합니다. `subject`만으로 충분히 설명된다면 생략할 수 있습니다.
- 호환성을 깨뜨리는 변경에는 `type` 뒤에 `!`를 추가하고(예: `feat!:`), `body`에 마이그레이션 방법을 설명합니다.
- `revert` 커밋은 `body`에 원본 커밋의 해시를 반드시 명시합니다.

## Pull Request Convention

- PR 제목은 [Commit Message Convention](#commit-message-convention)을 따릅니다.
- PR 본문은 한국어로 작성하고 [PR 템플릿](.github/PULL_REQUEST_TEMPLATE.md)을 따릅니다.

플랫폼별 구현 선택과 계약 패키지의 경계는 [플러그인 조립 문서](docs/plugin-composition.md)를 따릅니다. 공통 UI와 계약 패키지는 구현 플러그인에 실행 의존성을 추가하지 않습니다.
