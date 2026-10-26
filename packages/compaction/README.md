# @keundal/compaction

축약 요청 `CompactionRequest`, 결과 `CompactionResult`, 공통 정책 `CompactionPolicy`와 모델별 설정 `AgentCompactionConfig`의 계약을 제공합니다. LLM 호출이나 요약 구현은 포함하지 않습니다.

기본 요약 구현과 백그라운드 준비·입력 예산 검사는 [`@keundal/compaction-summary`](../compaction-summary/README.md)가 제공합니다. 기존 `@keundal/compaction`에서 가져오던 `compact()`와 `SummaryCompactionConfigSchema`는 해당 패키지에서 가져옵니다.
