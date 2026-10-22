# Trace를 버전이 있는 Journal 메타데이터로 저장한다

Trace 계약은 `@keundal/core`에 두고, 실행 루프는 버전이 있는 `CUSTOM` 이벤트를 기존 Generation Journal에 기록합니다. 별도 Trace 저장소는 실행 기록과 두 번 쓰는 문제가 생기므로 사용하지 않습니다. 원본 AG-UI 이벤트의 상대 순서와 `RUN_FINISHED`를 전달하는 커밋 조건은 유지하며, 조회 화면은 같은 `runId`의 Journal을 해석합니다.
