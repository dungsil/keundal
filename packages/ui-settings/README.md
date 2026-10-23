# @keundal/ui-settings

설정 화면을 `page.settings` 슬롯에 등록하는 UI 플러그인입니다. 돌아가기 버튼, 섹션 탐색, 선택한 섹션을 그립니다. 섹션을 바꿔도 이전 섹션의 입력 상태를 유지합니다.

`settings.section` 슬롯을 `keyed` 종류로 선언합니다. 항목의 `key`는 `/settings/<key>` 경로이며, `order` 순서로 탐색에 나타납니다. `meta`에는 언어별 이름, 아이콘, 그룹(`general` 또는 `plugins`)과 선택 쿼리를 적습니다. `/settings`를 섹션 없이 열면 `chat-app`이 `section` 쿼리, `meta.query`, 첫 섹션 순서로 이동할 섹션을 고릅니다.

화면 설정 섹션(`appearance`)과 사이드바 아래쪽의 설정 링크도 등록합니다.
