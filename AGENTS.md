# Repository Guidelines

## 패키지 구성

| 패키지                                 | 역할                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `@keundal/core`                        | 서비스 계약, Cordis Context 확장, AG-UI 타입과 검증 기능을 제공합니다. |
| `@keundal/plugin-agent-simple`         | 세 서비스와 대화 축약 함수를 조합해 `ctx.agent.run()`을 제공합니다.    |
| `@keundal/plugin-llm-openai`           | OpenAI Responses API로 `llm`을 구현합니다.                             |
| `@keundal/plugin-llm-gemini`           | Gemini API로 `llm`을 구현합니다.                                       |
| `@keundal/plugin-store-memory`         | `session`과 `generation`을 메모리 저장소로 구현합니다.                 |
| `@keundal/compaction`                  | 이전 대화를 요약하고 최근 대화를 보존하는 축약 함수를 제공합니다.      |
| `@keundal/plugin-store-indexeddb`      | 브라우저의 IndexedDB로 `session`과 `generation`을 구현합니다.          |
| `@keundal/plugin-store-sqlite`         | SQLite 파일로 `session`과 `generation`을 구현합니다.                   |
| `@keundal/tsconfig`, `@keundal/tsdown` | 공통 TypeScript·빌드 설정을 제공합니다.                                |

서비스 계약은 `packages/core/src/{llm,session,generation,compaction}.ts`에 정의하고, 구체 구현은 플러그인으로 주입합니다. 저장소가 공유하는 대화 병합과 실행 메시지 조립은 `packages/core/src/messages.ts`에 둡니다. AG-UI 타입, 이벤트 상수, 검증 기능은 `@keundal/core`에서 가져옵니다. `@ag-ui/core` 직접 의존은 코어의 프로토콜 래퍼에서만 관리합니다.

플러그인 설정과 사용법은 [OpenAI 문서](packages/plugin-llm-openai/README.md), [메모리 저장소 문서](packages/plugin-store-memory/README.md), [IndexedDB 저장소 문서](packages/plugin-store-indexeddb/README.md), [SQLite 저장소 문서](packages/plugin-store-sqlite/README.md)를 참고합니다.

## 서비스 계약

- `llm`은 모델 한도 조회, 입력 토큰 계산, 공급자 스트림 호출을 담당합니다. 실행 수명 이벤트와 대화 저장은 담당하지 않습니다.
- `session.prepare()`는 원본을 변경하지 않고 생성 입력과 기준 revision을 준비하며, `threadId`와 `runId`를 유지합니다.
- `session.commit()`은 기준 revision을 검사합니다. 생성 종료 기록을 받으면 메시지·journal·종료 상태를 한 단위로 확정하고 중복 반영을 방지합니다.
- `@keundal/compaction`의 `compact()`는 원본을 보존하면서 입력 예산에 맞춰 축약한 메시지, 요약, 요약에 반영한 메시지 ID를 반환합니다.
- `generation`은 실행·journal·커밋·복구를 담당하며, 성공한 `RUN_FINISHED`는 커밋 이후에 전달합니다. 내구성이 필요한 저장소는 커밋의 영속성을 보장해야 합니다.
- `generation.recover()`는 저장된 부분 응답과 확정된 종료 상태를 보존하고, 미완료 실행을 `interrupted`로 확정합니다. LLM을 다시 호출하거나 자동 재시도하지 않습니다.
- 각 서비스는 취소 신호를 실제 작업에 연결하고 자원을 정리해야 합니다.

## 에이전트 조합

`simpleAgentPlugin`은 `llm`, `session`, `generation`을 주입받고 `@keundal/compaction`의 축약 함수를 직접 호출합니다. 축약 설정은 에이전트의 `compaction` 옵션으로 전달합니다. `ctx.agent.run(input, { signal })`은 AG-UI `RunAgentInput`을 받아 `AsyncIterable<AGUIEvent>`를 반환합니다.

세션 입력을 준비한 뒤 컨텍스트 한도에서 출력 예산을 뺀 크기와 입력 크기를 비교합니다. 예산을 초과하면 한 번 축약하고 다시 계산하며, 여전히 초과하면 생성을 시작하지 않습니다. 준비된 입력·revision·축약 결과는 `generation.run()`에 전달하고, 반환된 이벤트를 그대로 전달합니다. 준비 오류는 순회 중 예외로 전달합니다.

플러그인 해제와 순회 중단은 준비·생성 작업을 취소합니다. 주입된 서비스를 교체하면 Cordis가 조합 플러그인의 수명을 갱신하며, 서비스별 격리는 `ctx.isolate('llm')`을 사용합니다.

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
- `typecheck`는 `tsconfig.test.json`으로 테스트 코드까지 검사합니다.
- CI 공통 환경과 의존성 설치는 `.github/actions/setup/action.yml`에서 관리합니다.

커밋, 이슈, PR을 만들 때는 [CONTRIBUTING.md](CONTRIBUTING.md)를 따릅니다.
