# @keundal/ui-settings

설정 화면을 `page.settings` 슬롯에 등록하는 UI 플러그인입니다. 돌아가기 버튼, 섹션 탐색, 선택한 섹션을 그립니다. 섹션을 바꿔도 이전 섹션의 입력 상태를 유지합니다.

`settings.section` 슬롯을 `keyed` 종류로 선언합니다. 항목의 `key`는 `/settings/<key>` 경로이며, `order` 순서로 탐색에 나타납니다. `meta`에는 언어별 이름, 아이콘, 그룹(`general` 또는 `plugins`)과 선택 쿼리를 적습니다. `/settings`를 섹션 없이 열면 `chat-app`이 `section` 쿼리, `meta.query`, 첫 섹션 순서로 이동할 섹션을 고릅니다.

화면 설정 섹션(`appearance`), 백업·복원 섹션(`data`)과 사이드바 아래쪽의 설정 링크도 등록합니다.

백업·복원은 `chatRuntime`이 제공하는 콜백으로 대화·생성 기록과 사용자 설정을 JSON 파일로 옮깁니다.
파일을 검증한 뒤 개수를 미리 보여 주고 설정 교체 동의를 받습니다. 저장소가 백업 계약을 제공하지 않거나
실행 중·ID 충돌·저장 실패가 발생하면 오류를 표시합니다. 포맷과 보안 범위는 [데이터 백업·복원](../../docs/data-backup.md)을 참고합니다.
