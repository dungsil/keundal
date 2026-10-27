# 필수 서비스 계약과 실행 정책을 기능 패키지로 분리한다

## 배경

`core`에 필수 서비스 계약과 기능별 검증·정책이 계속 추가되었다. `agent-loop`도 축약 준비, 도구 반복, 스킬 로딩, 위임과 실행 추적을 직접 소유했다. 기능 하나를 사용하는 소비자가 전체 계약에 의존하고, 새 기능을 같은 패키지에 쌓기 쉬운 구조였다.

[DeepSeek Harness의 서비스 경계](https://github.com/deepseek-ai/deepseek-harness/tree/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages)를 참고한다. 서비스 정의를 소비자가 가져오고 구현을 조합하는 방향을 따른다. DSH의 이벤트 저장 형식이나 실행 수명을 그대로 옮기지는 않는다. Keundal의 세션 revision, 원자적 종료 커밋, 저장소별 잠금·임차와 복구 계약을 유지한다.

이 결정은 ADR-0002의 Trace 계약 위치와 ADR-0004의 실행 정책 소유권을 변경한다. Journal 형식과 플랫폼 조립 규칙은 변경하지 않는다.

## 경계

| 패키지                        | 책임                                                                   |
| ----------------------------- | ---------------------------------------------------------------------- |
| `@keundal/core`               | AG-UI 타입·검증, 메시지 조립·병합, 공통 실행 옵션과 Steer              |
| `@keundal/llm`                | LLM 계약, 공급자 오류 분류, 모델 목록·스트림 한도                      |
| `@keundal/session`            | 세션 계약, revision과 생성 메시지 충돌 검사                            |
| `@keundal/generation`         | 생성·종료·복구·구독 계약과 Journal 구독 전달                           |
| `@keundal/skill`              | 스킬 계약과 `./tools`의 목록·로딩 도구                                 |
| `@keundal/compaction`         | 축약 요청·결과와 모델별 정책의 타입                                    |
| `@keundal/compaction-summary` | 요약 축약, `./controller`의 예산 검사·백그라운드 준비·초과 오류 재시도 |
| `@keundal/tools`              | 실행 가능한 도구와 실행 컨텍스트의 계약                                |
| `@keundal/tool-execution`     | 도구 호출 수집·검증·실행과 후속 모델 요청                              |
| `@keundal/deferred-tools`     | 지연 도구의 검색·활성화·권한 재검사                                    |
| `@keundal/trace`              | 추적 계약·집계·가격 계산과 `./recording`의 기록                        |
| `@keundal/prompt`             | 프롬프트 프리셋의 검증·조건·변수·조립                                  |
| `@keundal/subagent`           | 역할 검증과 `./tools`의 위임 도구                                      |
| `@keundal/agent-loop`         | 위 기능을 조합하는 기본 실행 흐름과 `AgentConfig`                      |

`core`는 기능 패키지를 가져오거나 다시 내보내지 않는다. Cordis Context 확장은 각 서비스 계약을 선언한 패키지가 소유한다. 서비스 소비자는 필요한 계약을 직접 가져온다. 타입 확장만 필요하면 `import type {} from '@keundal/skill'`처럼 명시한다.

축약과 도구 실행은 서비스 계약과 구분한 재사용 라이브러리다. 새 Cordis 루트나 중복 레지스트리를 만들지 않는다. 기본 실행 루프가 선택한 구현을 조합하며, 기능별 설정과 런타임 매니페스트 형식은 유지한다. 이 분리만으로 모든 정책이 별도 런타임 플러그인이 되거나 UI에서 독립적으로 꺼지는 것은 아니다.

저장소는 `session`과 `generation`을 같은 저장소에 연결한다. LLM 교체 시 `session`과 데이터는 유지하고 `generation`과 에이전트를 다시 구성한다. 저장소별 트랜잭션·잠금·임차를 공통 구현으로 합치지 않는다.

## 가져오기 경로 변경

- `LLMService`, `LLMRequest`, `Reasoning`, 모델 목록과 스트림 한도는 `@keundal/core` 대신 `@keundal/llm`에서 가져온다.
- `SessionService`, `SessionSnapshot`, `assertGenerationMessageIds`는 `@keundal/session`에서 가져온다.
- `GenerationService`, 생성 타입과 Journal 구독은 `@keundal/generation`에서 가져온다.
- 스킬 타입은 `@keundal/skill`, 추적 타입·함수는 `@keundal/trace`, 프리셋은 `@keundal/prompt`, 역할은 `@keundal/subagent`에서 가져온다.
- `CompactionRequest`, `CompactionResult`, `CompactionPolicy`, `AgentCompactionConfig`는 `@keundal/compaction`에서 가져온다. `compact()`와 `SummaryCompactionConfigSchema`는 `@keundal/compaction-summary`로 옮긴다.
- `AgentPricing`, `ModelPrice`는 `agent-loop` 대신 `@keundal/trace`에서 가져온다.
- `createDeferredToolSession`, `parseDeferredToolsConfig`와 관련 타입은 `tools` 대신 `@keundal/deferred-tools`에서 가져온다.
- 사용하지 않는 전체 서비스 확장 타입 `KeundalContext`는 제거한다. `cordis`의 `Context`와 필요한 서비스 계약을 직접 사용한다.

소비자의 소스·테스트와 `package.json`을 함께 바꾼다. 이전 경로의 재노출 별칭은 두지 않는다. 저장된 대화, Journal과 사용자 설정에는 이전 작업이 필요하지 않다.

## 검증

`pnpm check:boundaries`는 코어의 기능 패키지 참조와 새 계약 패키지의 구현 플러그인 참조를 거부한다. 기존 서비스·저장소·에이전트·화면 테스트는 새 공개 진입점으로 실행하며 커밋·복구·취소와 실행 순서가 유지되는지 검사한다.
