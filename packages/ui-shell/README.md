# @keundal/ui-shell

앱의 전역 화면을 `root` 슬롯에 등록합니다. 시작 화면, 테마·화면 상태의 준비 대기, 입력 차단, 로딩 표시와 전역 메타데이터를 담당합니다. `chatRuntime.ready`는 등록의 `inject`에서 ref로 전달하며, 컴포넌트는 서비스 객체를 받지 않습니다.

`app.layout`을 `single` 슬롯으로 선언합니다. 본문 틀은 `@keundal/ui-layout`이 이 슬롯에 등록합니다. Nuxt UI 공급자와 `SlotRoot`의 연결은 `@keundal/chat-app`에 유지합니다.

기존 시작 화면의 페이드 시간과 움직임 줄이기 설정을 유지하며, 시작 화면이 사라진 뒤에는 모델을 바꿔도 다시 표시하지 않습니다. 관리 화면을 복구할 수 있도록 항상 등록합니다.
