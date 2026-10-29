# @keundal/ui-chart

`chat.message.tool` 슬롯에 `chart` 카드를 등록하는 UI 플러그인입니다. 선 그래프 컴포넌트는 처음 표시할 때 불러옵니다. 차트 모듈 `nuxt-charts`와 번역은 이 패키지가 관리합니다.

사용할 앱의 `nuxt.config.ts`의 `extends`와 `app/ui-plugins.ts`에서 함께 추가하거나 제거합니다. 실행 도구는 앱이 `@keundal/plugin-tool-chart`로 별도 조립합니다. UI는 이 구현에 의존하지 않고 `@keundal/chat/tools/chart`의 결과 타입만 사용합니다.
