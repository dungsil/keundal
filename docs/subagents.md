# 서브에이전트 구현 비교

DeepSeek Harness의 커밋 `687f282e8625c6b8d11ff58211a90524be2e4317`을 검토했습니다.
이 문서는 참고한 설계와 Keundal에 적용한 범위를 기록합니다. 구현 코드를 복사하지 않고
Keundal의 도구 실행, AG-UI 이벤트와 저장소 계약에 맞춰 구현했습니다.

| 참고한 설계                                 | Keundal에 적용한 동작                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 준비 전에 실행 자리를 확보하고 정리 후 반환 | 부모 실행마다 `maxActiveSubagents`를 적용합니다. 기본값은 8이며 초과 요청은 자식을 만들기 전에 거절합니다.                       |
| 종료 이유와 응답을 구분                     | `completed`, `failed`, `rejected` 상태를 반환합니다. 자식 실패가 형제와 부모 전체를 종료하지 않으며 부모 취소는 계속 전파합니다. |
| 작업 설명을 자식의 이름으로 보존            | 선택적인 `label`을 검증하여 자식 상태와 진행 UI에 기록합니다.                                                                    |
| 마지막 비어 있지 않은 답변 선택             | 빈 종료 메시지가 앞선 유효한 답변을 지우지 않습니다. 실패 중 얻은 텍스트는 실패 상태의 부분 응답으로 표시합니다.                 |

동시 실행 제한은 호출 횟수 제한과 별개입니다. `maxToolCalls`는 전체 호출 수를 제한하고
`maxActiveSubagents`는 한 부모 실행에서 동시에 준비하거나 실행 중인 자식 수를 제한합니다.
현재 재귀 위임을 허용하지 않으므로 별도 하위 트리나 교착을 유발할 대기열이 필요하지 않습니다.

DeepSeek Harness는 자식 세션에 후속 메시지를 보내고, 외부 공급자를 연결하고, 작업을 백그라운드에서
계속할 수 있습니다. Keundal의 이번 구현은 한 번의 위임 결과를 기다리는 방식입니다.
따라서 메시징, 중단 후 재개, 외부 CLI 공급자, 자식별 모델 선택과 대화 복제는 추가하지 않았습니다.
이를 도입하려면 부모 요청 종료 이후의 자식 수명과 영속적인 소유권 계약을 먼저 정해야 합니다.

## 참고한 원본

- [서비스 계약과 실행 한도](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/README.md)
- [실행 자리 예약과 반환](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/activation.ts)
- [최종 어시스턴트 출력 선택](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/assistant-output.ts)
- [종료 이유별 부모 알림](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/subagent/src/continuation-messages.ts)
- [작업 설명을 이름으로 전달하는 위임 도구](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/subagent/tool-subagent/src/index.ts)
