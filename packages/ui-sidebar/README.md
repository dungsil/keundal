# @keundal/ui-sidebar

사이드바를 `layout.navigation` 슬롯에 등록합니다. 접기·크기 조절·좁은 화면의 열림 상태를 관리하며, 경로를 이동하면 사이드바를 닫습니다.

`layout.sidebar`와 `layout.sidebar.footer`를 `list` 슬롯으로 선언합니다. 두 슬롯의 항목은 기존과 같이 `collapsed`와 `close()`를 소유자 값으로 받습니다. 대화 목록과 설정 탐색 항목은 각 기능 플러그인이 등록합니다.

본문의 초점과 건너뛰기 링크는 `@keundal/ui-shell`이 담당합니다. 관리 화면에 접근할 수 있도록 사이드바는 항상 등록합니다.
