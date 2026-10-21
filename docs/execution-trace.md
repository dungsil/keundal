# Execution Trace와 Deferred Tools

## 기존 계약을 유지하는 범위

Trace 계약과 집계는 `@keundal/core`가 제공합니다. 공통 실행 루프가 모델 호출, 도구 실행, Compaction과 에이전트 실행을 기록합니다. 공용 Chat UI는 저장소나 공급자 구현을 직접 참조하지 않습니다.

Generation Journal은 이미 순서가 있는 AG-UI 이벤트를 저장합니다. Trace는 이 Journal의 `CUSTOM` 이벤트를 재사용하므로 별도 저장소나 데이터 이전이 필요하지 않습니다. 원본 실행 이벤트의 상대 순서와 성공한 `RUN_FINISHED`를 커밋 뒤에 전달하는 조건은 바꾸지 않습니다.

## Trace 데이터 계약

`TRACE_EVENT`의 이름은 `keundal.trace`입니다. 이벤트 값은 `{ version: 1, span }`이며, `span.version`도 `1`입니다. 같은 Span의 시작과 종료는 같은 `spanId`를 사용합니다. 조회할 때 마지막 상태를 선택합니다.

| 필드                                        | 의미                                                                | 누락할 수 있는 조건                          |
| ------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `traceId`, `spanId`, `runId`                | Trace, 작업, 원본 실행의 식별자입니다.                              | 필수입니다.                                  |
| `parentSpanId`, `toolCallId`                | 상위 작업과 AG-UI 도구 호출을 연결합니다.                           | 상위 작업이나 도구 호출이 없으면 생략합니다. |
| `kind`, `name`, `sequence`                  | 작업 유형, 이름, 시작 순서를 나타냅니다.                            | 필수입니다.                                  |
| `startedAt`, `endedAt`, `status`            | 밀리초 단위 시각과 실행 상태를 나타냅니다.                          | 실행 중에는 종료 시각이 없습니다.            |
| `model`, `usage`, `ttftMs`, `cost`, `error` | 모델, 사용량, 첫 토큰까지 걸린 시간, 비용과 안전한 오류 분류입니다. | 해당 정보를 알 수 없으면 생략합니다.         |
| `detached`                                  | 실행과 분리된 배경 작업의 Span임을 나타냅니다.                      | 배경 작업이 아니면 생략합니다.               |

`kind`는 `agent`, `model`, `tool`, `compaction`을 구분합니다. `sequence`는 같은 `runId` 안에서의 시작 순서이며 Journal의 이벤트 순번과 다릅니다. 하나의 Span이 두 번 이상 갱신되어도 시작 순서는 유지합니다.

`detached: true`이고 `endedAt`이 없으면 실행 종료 시점에 배경 작업이 계속되었음을 뜻합니다. 이 Span의 상태는 관측 시점의 값이며, 종료 사실로 해석하지 않습니다.

자식 에이전트는 부모와 같은 `traceId`를 사용하지만 원래 `runId`를 유지합니다. 검증한 Trace 메타데이터만 부모 Journal에 전달하며, 자식 응답 본문은 Trace에 복사하지 않습니다. Viewer는 부모 Trace에 속한 자식 모델 호출도 한 번씩 집계합니다.

`LLM_USAGE_EVENT`의 이름은 `keundal.llm.usage`입니다. 공급자가 반환한 입력·출력·캐시 토큰을 공통 형식으로 변환합니다. `usage.source`는 실제 공급자 사용량인 `provider`와 계산한 값인 `estimate`를 구분합니다.

`inputTokens`는 캐시 토큰을 포함하는 총 입력 토큰입니다. `cacheReadTokens`와 `cacheWriteTokens`를 총 입력에 다시 더하지 않습니다. Anthropic처럼 캐시를 별도로 보고하는 공급자는 이 기준으로 변환합니다.

### 집계와 비용

`readTraceSpans()`는 지원하는 버전과 필드를 검사하고 Span 수를 제한합니다. `summarizeTrace()`는 같은 `spanId`를 한 번만 집계합니다. 모델 호출에서 사용량을 합산하므로 상위 에이전트와 Compaction의 사용량을 다시 더하지 않습니다.

비용은 통화와 출처를 함께 보관합니다. 가격이 없다는 이유로 비용을 `0`으로 만들지 않습니다. 비용을 모르는 모델 호출이 있으면 전체 비용은 미확정 상태입니다. 공급자가 사용량을 주지 않거나 실행이 중단되면 수집을 마친 호출의 사용량만 알려질 수 있습니다.

### 민감한 정보

Trace는 API 키, 인증 헤더, 환경 변수와 요청 설정을 제외합니다. 도구 인자와 결과 본문도 수집하지 않습니다. 오류는 안전한 분류로 기록하며 원본 공급자 오류 문자열을 Trace에 넣지 않습니다.

기존 Journal의 AG-UI 도구 인자·결과 이벤트는 기존 저장 계약대로 유지합니다. Trace 화면은 이 본문을 상세 정보로 노출하지 않습니다. Journal 자체의 접근 권한과 보관 정책은 저장소와 호스트가 담당합니다.

## Trace Viewer

대화 화면에서 실행을 선택하여 Trace를 조회합니다. Simple 보기는 주요 작업을, Full 보기는 수집한 단계 전체를 표시합니다. 단계 트리와 타임라인에서 모델 호출, 도구 실행과 Compaction을 구분합니다. 상세 정보는 선택한 단계의 식별자, 시간과 알려진 사용량을 표시합니다.

원본 실행과 Trace는 같은 `runId`로 연결합니다. 로컬과 원격 `ChatStore`는 `getRun(runId)`로 한 실행의 Journal을 조회합니다. 완료된 어시스턴트 표시 메시지의 `id`도 해당 `runId`이므로 전체 실행 목록을 읽지 않고 기록을 찾습니다.

실행 중에는 이미 받은 AG-UI의 `keundal.trace` 이벤트를 즉시 해석합니다. 첫 공급자 콘텐츠가 없거나 Journal 배치 저장이 끝나지 않아도 모델 Span을 표시합니다. 스트림에서 받은 메타데이터는 현재 실행의 메모리에만 최대 200개 보관하며 대화 본문에 다시 저장하지 않습니다.

기존 실행에 Trace가 없으면 사용할 수 있는 실행 상태를 표시합니다. Span이나 종료 이벤트가 저장되지 않았어도 화면을 유지합니다. 취소와 복구 후에는 Generation Snapshot의 종료 상태를 기준으로 실행 중 Span을 해석합니다.
Generation Snapshot의 `status`가 종료 상태를 결정합니다. 저장소는 실패, 취소 또는 복구로 종료된 Snapshot에서 root Trace 상태도 같은 값으로 제공합니다.

화면은 가장 나중에 생성한 어시스턴트 응답 20개에 조회 패널을 제공합니다. 열린 패널만 Journal을 읽고 실행 중에는 종료 상태와 저장 기록을 1.2초 간격으로 확인합니다. 동시에 같은 패널의 조회를 두 번 실행하지 않으며, 추가한 Journal 이벤트만 새로 해석합니다.

한 패널은 최대 200개 단계를 보관하고 표시합니다. 한도를 넘으면 표시한 단계만 집계했다는 안내를 붙입니다. Simple 보기는 에이전트 묶음을 생략하며, Full 보기는 상위 단계와 Span 식별자를 함께 표시합니다.

## Deferred Tools 설정

`AgentConfig.tools`는 항상 노출하는 직접 도구입니다. `deferredToolProvider`는 현재 사용자가 실행할 수 있는 검색 대상 도구를 반환합니다. `deferredTools`에서 검색과 Schema 노출 한도를 정합니다.

기본 web과 Node.js 조립은 MCP 도구와 Agent Plugins의 MCP 도구를 검색 대상으로 분리합니다. 매니페스트의 `agent.config.deferredTools`를 생략하면 기존처럼 모든 허용 도구를 직접 노출합니다. 설정 예시는 [플러그인 조립 문서](plugin-composition.md#deferred-tools)를 참고합니다.

모델은 명시적 `search_tool`을 호출하여 도구 이름과 설명을 검색합니다. 검색 결과는 해당 실행에서 재사용하며, 상세 Schema는 다음 모델 요청에 전달합니다. 진행 중인 공급자 요청의 도구 집합을 바꾸지 않습니다.

| 설정                  | 기본값 | 제한 대상                                  |
| --------------------- | ------ | ------------------------------------------ |
| `maxSearchResults`    | 8      | 한 번의 검색 결과 수입니다.                |
| `maxActiveTools`      | 16     | 실행에서 활성화할 Deferred Tools 수입니다. |
| `maxSchemaBytes`      | 16,384 | 도구 하나의 Schema 크기입니다.             |
| `maxTotalSchemaBytes` | 65,536 | 활성화한 Schema의 전체 크기입니다.         |

검색은 실행 권한을 새로 부여하지 않습니다. 검색하지 않은 도구나 현재 권한이 없는 도구는 실행할 수 없습니다. 실행 직전에 현재 공급자를 확인하고, 기존 `ExecutableTool.execute`를 통해 MCP 허용 목록과 리소스 권한을 유지합니다.

도구 이름 충돌은 오류로 처리합니다. 도구가 제거되거나 정의가 바뀌면 이전 검색 결과만으로 실행하지 않습니다. 서버 연결에 실패하면 권한이 확인되지 않은 이전 실행 함수를 대신 호출하지 않습니다. 향후 Tool Approval을 실행 함수에 적용해도 같은 실행 경로를 유지합니다.

검색은 이름과 설명의 대소문자를 구분하지 않는 부분 문자열 비교입니다. 공백으로 나눈 검색어 가운데 하나 이상이 일치한 도구를 목록 순서대로 반환합니다. 의미 기반 검색이나 외부 검색 서비스는 사용하지 않습니다.

## 입력 토큰 비교

`packages/plugin-agent-chat/tests/fixtures/deferred-mcp-catalog.ts`는 서비스별 Schema 12종과 동작 10종으로 합성 도구 120개를 만듭니다. GitHub, Drive, Calendar, Linear, AWS, Datadog, OpenWeatherMap, Slack과 Jira 형식을 참고한 중첩 필터·페이지·열거형·필수 필드를 포함합니다. 실제 MCP 서버에서 수집한 목록은 아닙니다.

같은 질문, 검색 대상 목록과 상시 도구 `local_status`를 사용했습니다. 입력 토큰 추정식은 모델에 실제 전달한 `RunAgentInput` 전체를 대상으로 한 `ceil(UTF-8 JSON bytes / 4)`입니다. 후속 대화와 도구 검색 결과도 포함합니다.

| 항목                       | 직접 노출 | Deferred Tools |
| -------------------------- | --------: | -------------: |
| 첫 요청의 도구 Schema 수   |       121 |              2 |
| 첫 요청의 입력 토큰 추정치 |    17,806 |            150 |
| 모델 요청 수               |         2 |              3 |
| 전체 입력 토큰 추정치      |    35,693 |          1,050 |

추가 검색 요청을 포함해 전체 입력 토큰 추정치가 97.06% 감소했습니다. 이는 합성 목록의 텍스트 추정치이며 실제 공급자 토큰이나 청구액을 측정한 결과가 아닙니다. 출력 토큰, 도구 검색 지연과 모델별 가격까지 포함한 비용 절감률로 해석하지 않습니다.

검증 명령은 `pnpm --filter @keundal/plugin-agent-chat test`입니다. 테스트는 실행한 모델 요청을 수집하여 첫 요청과 전체 실행의 값을 출력합니다.

## 관측 범위와 제한

가격표가 없는 기본 공급자는 토큰만 기록하며 비용은 미확정으로 표시합니다. 공급자가 실제 비용을 제공하는 구현은 `llmUsageEvent()`의 `cost`에 통화와 출처를 전달합니다. 토큰과 비용을 추정해서 전달할 때는 반드시 `source: 'estimate'`를 사용합니다.

도구 Span은 호스트가 실행하는 `ExecutableTool`을 기준으로 합니다. 공급자 내부의 네이티브 웹 검색은 별도 도구 Span으로 만들지 않으며, 세부 실행 시간과 비용을 따로 계산하지 않습니다.

실행과 분리된 배경 축약은 관측을 종료한 뒤에도 계속 진행할 수 있습니다. 이 경우 마지막으로 확인한 사용량만 보관하며 최종 종료 시각이나 비용을 확정하지 않습니다. 작업을 기다리거나 취소하여 기존 실행 수명을 바꾸지 않습니다.

열린 패널의 `getRun()`은 실행 하나의 전체 Snapshot을 읽습니다. 추가 이벤트만 해석하는 최적화는 원격 전송량이나 저장소 읽기 양을 줄이지 않습니다. 한 패널의 중복 조회를 막고 실행 중에만 갱신하지만, 대형 Journal의 증분 조회 API는 제공하지 않습니다.

## 검증 결과

| 검사        | 실행 명령                          | 결과                                                                             |
| ----------- | ---------------------------------- | -------------------------------------------------------------------------------- |
| 빌드        | `pnpm build`                       | 통과했습니다.                                                                    |
| 타입        | `pnpm typecheck --continue=always` | 통과했습니다.                                                                    |
| 린트        | `pnpm lint`                        | 통과했습니다. 변경하지 않은 `Prompt.vue`의 자동 import 경고 3건은 남아 있습니다. |
| 패키지 경계 | `pnpm check:boundaries`            | 통과했습니다. 린트에서도 같은 검사를 실행했습니다.                               |
| 전체 테스트 | `pnpm test --continue=always`      | Windows 권한 오류가 있어 전체 통과로 판정하지 않습니다.                          |

`@keundal/agent-plugins`의 기존 심볼릭 링크 검사 4건에서 `EPERM`이 발생했습니다. 파일 링크 생성 권한이 필요한 환경 문제이며, 이 작업에서는 OS 설정이나 해당 테스트를 바꾸지 않았습니다.

해당 패키지를 제외한 워크스페이스 재검증은 `pnpm exec turbo run test --filter=!@keundal/agent-plugins --continue=always`로 통과했습니다. 이후 변경한 공용 UI는 `pnpm --filter @keundal/chat-app test`로 198개 테스트를 다시 통과했습니다.

자동 테스트는 실제 Agent와 Journal에서 부모·자식 관계, 시작 순서, 원본 이벤트 순서와 토큰·캐시·비용 중복 배제를 확인합니다. 검색 전 호출 차단, 권한 취소, 같은 응답에서의 호출 차단, 최신 실행 함수, 연결 해제와 실행별 격리도 확인합니다. 공급자의 실패 응답 사용량, Compaction 하위 모델과 분리된 배경 작업도 검증합니다.

실제 브라우저에서는 SQLite 호스트, stdio MCP와 로컬 OpenAI 형식 공급자를 연결했습니다. 첫 공급자 응답 전 모델 Span, Simple·Full과 상세 정보, 완료 상태, 새로고침 후 Journal과 Trace가 없는 이전 실행을 확인했습니다. Trace에는 인자와 인증 값이 없으며, 검색 다음 요청에만 MCP Schema를 노출했습니다.

브라우저 검증에는 합성 응답을 사용했습니다. 실제 공급자 호출이나 청구액을 측정한 검증은 아닙니다. 검증용 서버와 브라우저를 종료하고 임시 실행 파일을 제거했습니다.

## 참고한 LibreChat 구현

비교 기준은 LibreChat의 `e081b566a42d3a83b8102157bd7806cf4ff63b17`입니다. 코드와 구조를 비교했으며 React, LangChain과 Langfuse를 Keundal에 추가하지 않았습니다.

1. [Trace Viewer](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/src/components/Chat/Trace/Viewer.tsx)는 Simple·Full 보기와 지연 조회를 제공합니다.
2. [Trace 모델](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/client/src/components/Chat/Trace/model.ts)은 모든 모델 호출의 비용을 알 때만 전체 비용을 확정합니다.
3. [도구 분류](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/packages/api/src/tools/classification.ts)는 MCP 레지스트리와 Approval 연결을 유지하면서 검색 도구를 등록합니다.
4. [Deferred Tools 검증](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/e2e/specs/mock/deferred-tools-hitl.spec.ts)은 검색한 Schema만 후속 요청에 바인딩하는지 검사합니다.
5. [저장된 Context Usage 검증](https://github.com/LibreChat-AI/LibreChat/blob/e081b566a42d3a83b8102157bd7806cf4ff63b17/e2e/specs/mock/scenarios/persisted-context-usage.spec.ts)은 현재 턴과 누적 캐시 사용량을 구분합니다.
