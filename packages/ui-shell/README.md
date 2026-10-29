# @keundal/ui-shell

앱의 전역 화면을 `root` 슬롯에 등록합니다. 시작 화면, 테마·화면 상태의 준비 대기, 입력 차단, 로딩 표시와 전역 메타데이터를 담당합니다. `chatRuntime.ready`는 등록의 `inject`에서 ref로 전달하며, 컴포넌트는 서비스 객체를 받지 않습니다.

Nuxt UI 공급자와 `SlotRoot`, 오류 화면, 본문 틀, 건너뛰기 링크와 경로 이동 후 본문 초점도 이 패키지가 담당합니다. `page.home`, `page.chat`, `page.history`, `page.settings`, `layout.navigation`, `layout.overlay`를 선언하며, 슬롯 계약은 `@keundal/ui/app/contracts/layout.ts`에 둡니다. 사이드바의 표시와 닫기는 `@keundal/ui-sidebar`가 담당합니다.

web과 desktop은 각 앱의 `nuxt.config.ts`와 `app/ui-plugins.ts`에서 필요한 기능을 직접 조립합니다. 이 패키지는 다른 UI 구현이나 기능 목록을 가져오지 않습니다. 경로는 홈·대화·기록·설정 기능 패키지가 `pages:extend`로 등록합니다.

기존 시작 화면의 페이드 시간과 움직임 줄이기 설정을 유지하며, 시작 화면이 사라진 뒤에는 모델을 바꿔도 다시 표시하지 않습니다. 관리 화면을 복구할 수 있도록 항상 등록합니다.
