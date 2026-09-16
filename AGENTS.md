# Repository Guidelines

## 패키지 구성

| 패키지                            | 역할                                                          |
| --------------------------------- | ------------------------------------------------------------- |
| `@keundal/core`                   | 네 서비스의 계약과 Cordis Context 타입 확장을 제공합니다.     |
| `@keundal/plugin-agent-simple`    | 주입된 서비스를 조합해 에이전트 실행 진입점을 제공합니다.     |
| `@keundal/plugin-llm-openai`      | OpenAI Responses API로 `llm` 서비스를 구현합니다.             |
| `@keundal/plugin-store-memory`    | `session`과 `generation`을 메모리 저장소로 구현합니다.        |
| `@keundal/plugin-store-indexeddb` | 브라우저의 IndexedDB로 `session`과 `generation`을 구현합니다. |
| `@keundal/tsconfig`               | 워크스페이스에서 사용하는 TypeScript 설정을 제공합니다.       |
| `@keundal/tsdown`                 | Node.js 라이브러리의 공통 빌드 설정을 제공합니다.             |

`packages/core/src/llm.ts`, `generation.ts`, `session.ts`, `compaction.ts`는 각각 추상 서비스 계약을 정의합니다. `context.ts`는 `ctx.llm`, `ctx.generation`, `ctx.session`, `ctx.compaction`의 타입을 확장합니다. 각 서비스의 구체 구현은 별도 플러그인으로 주입합니다.

플러그인과 라이브러리 사용자는 AG-UI 타입, 이벤트 상수, 검증 기능을 `@keundal/core`에서 가져옵니다. `@ag-ui/core`에 대한 직접 의존은 코어의 프로토콜 래퍼에서 관리합니다.

## 서비스 계약

- `llm`은 모델 한도 조회, 입력 토큰 계산, 공급자 스트림 호출을 담당합니다.
- `session`은 저장된 대화 조회, 요청과 대화를 바탕으로 한 생성 입력 준비, 메시지와 상태의 커밋을 담당합니다. 입력 준비는 저장된 원본을 변경하지 않고 `threadId`와 `runId`를 유지합니다.
- `compaction`은 주어진 입력 토큰 예산에 맞춰 문맥을 축약합니다. 원본 대화를 보존하고, 축약된 메시지와 요약, 요약에 반영한 메시지 ID를 반환합니다.
- `generation`은 준비된 입력의 실행, journal 기록, 내구성 커밋, 저장 지점까지의 복구를 담당합니다. 성공한 `RUN_FINISHED`는 커밋 이후에 전달해야 합니다.

`session.commit()`은 기준 revision을 확인합니다. 생성 종료 기록을 함께 전달받으면 메시지 반영과 journal·종료 상태를 하나의 커밋 단위로 처리하고, 같은 실행을 중복 반영하지 않아야 합니다.

`generation.recover()`는 저장된 부분 응답과 실행 상태를 복원합니다. 확정된 종료 상태를 유지하고, 미완료 작업은 `interrupted`로 확정합니다. 복구 과정에서는 LLM을 다시 호출하거나 자동 재시도하지 않습니다.

현재 패키지는 서비스 계약, 조합 플러그인, OpenAI Responses 기반 LLM 플러그인, 메모리 저장소와 IndexedDB 저장소 플러그인을 제공합니다. 저장소 구현은 위 계약의 일관성과 내구성을 보장해야 합니다. 메모리 저장소는 프로세스 수명 안에서만 상태를 유지합니다.

## OpenAI 연결

`@keundal/plugin-llm-openai`를 등록하면 `ctx.llm`을 제공합니다. 모델별 한도는 `models` 설정에서 조회하고, 입력 토큰 수는 Responses의 `input_tokens` API로 계산합니다. 생성 요청과 토큰 계산 요청은 같은 입력 변환을 사용합니다. 설정과 직접 호출 방법은 [플러그인 문서](packages/plugin-llm-openai/README.md)를 참고합니다.

공급자 플러그인은 텍스트·도구 호출·추론 이벤트를 AG-UI로 변환하며, 실행 수명 이벤트는 생성하지 않습니다. 실패·불완전 응답·스트림 단절은 예외로 전달합니다. 외부 취소, 순회 중단, Cordis 플러그인 해제는 진행 중인 HTTP 요청을 취소합니다. 공급자 수준의 자동 재시도와 대화 저장은 사용하지 않습니다.

## 메모리 저장소

`@keundal/plugin-store-memory`를 등록하면 `ctx.session`과 `ctx.generation`을 함께 제공합니다. 두 서비스는 하나의 `MemoryStore`를 공유하므로 실행 종료 기록과 세션 커밋이 한 단위로 확정됩니다. 설정으로 기존 저장소를 전달하면 서비스를 다시 등록한 뒤에도 저장 상태가 남아, `ctx.generation.recover()`가 남은 실행을 `interrupted`로 확정할 수 있습니다.

`prepare()`는 저장된 대화를 요청 메시지 앞에 병합하고, 같은 id의 요청 메시지로 저장된 항목을 대체합니다. 생성 실행은 `RUN_STARTED`부터 순서대로 journal에 기록하고, 성공한 실행만 생성한 메시지를 대화에 반영한 뒤 `RUN_FINISHED`를 전달합니다. 실패·취소·중단된 실행은 부분 응답을 실행 기록에만 남기고 대화와 상태를 바꾸지 않습니다.

이 저장소는 프로세스 메모리를 사용하므로 프로세스가 종료되면 내용이 사라지고 여러 프로세스가 공유할 수 없습니다. 내구성이 필요하면 같은 계약을 구현한 별도 저장소가 필요합니다.

## 브라우저 저장소

`@keundal/plugin-store-indexeddb`는 IndexedDB에 세션과 실행 기록을 보관합니다. 스트림 이벤트를 저장한 뒤 전달하고, 성공한 실행의 세션 변경과 종료 기록은 하나의 트랜잭션으로 확정합니다. 복구는 저장된 부분 응답을 반환하며 LLM을 다시 호출하지 않습니다.

여러 탭에서 같은 데이터베이스를 사용할 때는 Web Locks로 실행 소유권을 조정합니다. IndexedDB와 Web Locks가 제공되는 보안 컨텍스트에서 사용해야 합니다. 사용 방법과 브라우저 저장 공간의 한계는 [플러그인 문서](packages/plugin-store-indexeddb/README.md)를 참고합니다.

## 에이전트 조합

`@keundal/plugin-agent-simple`의 기본 내보내기는 `simpleAgentPlugin`입니다. 네 서비스를 등록한 뒤 `await ctx.plugin(simpleAgentPlugin, { model, maxOutputTokens })`로 조합 플러그인을 등록합니다. 이 플러그인이 제공하는 `ctx.agent.run(input, options?)`은 AG-UI `RunAgentInput`을 받아 `AsyncIterable<AGUIEvent>`를 반환합니다. `agent`는 플러그인에 속한 조합 진입점이며, 코어의 서비스 계약은 네 구성 요소를 기준으로 합니다.

플러그인은 세션에서 입력과 기준 revision을 준비하고, 모델 컨텍스트 한도에서 출력 토큰 예산을 뺀 크기와 입력 크기를 비교합니다. 입력이 예산을 초과하면 문맥을 한 번 축약하고 크기를 다시 확인합니다. 축약 후에도 예산을 초과하면 생성을 시작하지 않습니다.

준비된 입력, 세션 revision, 축약 결과를 `generation.run()`에 전달하고 반환된 이벤트를 그대로 전달합니다. 생성 시작 이전의 준비 오류는 순회 중 예외로 전달합니다. 실행 수명 이벤트 생성과 세션 커밋, 재시작 복구는 `generation` 구현이 담당합니다.

`run(input, { signal })`로 취소 신호를 전달할 수 있습니다. 조합 플러그인을 해제하거나 이벤트 순회를 중단하면 준비 및 생성 작업에 전달한 신호를 취소합니다. 각 서비스 구현은 신호를 실제 작업에 연결하고 자원을 정리해야 합니다.

주입된 서비스 구현을 교체하면 Cordis가 조합 플러그인의 수명을 갱신합니다. 교체할 서비스는 `ctx.isolate('llm')`처럼 서비스별로 격리할 수 있습니다.

## 개발과 실행

Node.js와 pnpm 버전은 루트 `package.json`의 `devEngines`에 지정되어 있습니다.

Node.js 패키지는 `@keundal/tsconfig/node.json`을 확장하고, `rootDir`와 `outDir` 같은 패키지별 경로를 각자의 `tsconfig.json`에 지정합니다.

패키지의 `tsdown.config.ts`는 `@keundal/tsdown`의 공통 설정을 사용합니다. tsdown은 `src/index.ts`를 진입점으로 ESM 코드와 타입 선언을 `dist`에 생성합니다. 타입 검사는 `tsc --noEmit`으로 수행하며, 테스트는 Vitest로 실행합니다.

코어와 플러그인의 테스트는 각 패키지의 `tests/*.test.ts`에 두고 Vitest의 단언문을 사용합니다. `typecheck`는 `tsconfig.test.json`으로 테스트 코드도 검사합니다. 테스트는 패키지의 공개 진입점을 사용하므로 Turbo가 해당 패키지를 빌드한 뒤 테스트를 실행합니다.

빌드·타입 검사·테스트 명령은 Turbo로 실행합니다. `turbo.json`에서 패키지 의존성에 따른 빌드 순서와 `dist` 출력 캐시를 관리합니다. 타입 검사는 빌드 의존성 없이 실행합니다.

```sh
pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

## CI

공통 환경 설정과 의존성 설치는 `.github/actions/setup/action.yml`의 composite action에서 관리합니다. 각 작업은 저장소를 체크아웃한 뒤 `./.github/actions/setup`을 호출합니다.

## Commit & Pull Request

- 커밋, 이슈 혹은 PR을 만들 때만 [CONTRIBUTING.md](CONTRIBUTING.md)를 따릅니다.
