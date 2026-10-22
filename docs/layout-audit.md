# 웹 UI 레이아웃 점검

2026-10-22 기준으로 `apps/web` 프로덕션 빌드를 `localhost:3000`에서 띄우고 Chrome DevTools Protocol로 측정한 결과입니다. 이 문서는 지적한 항목만 기록하며, 수정은 하지 않았습니다.

측정한 뷰포트는 320·360·375·414·480·640·768·1024·1280·1440·1920px 폭과 320×480·375×600·1280×500·1280×600·1280·700·1024×700·640×450(200% 확대) 높이입니다. Navbar 가림은 `document.elementFromPoint`로 확인했습니다. 320px에서는 실제 마우스 클릭을 보내도 URL이 `/settings/appearance`에 머물렀습니다.

## HIGH

### 설정 화면의 "뒤로 돌아가기" 버튼

`packages/chat-app/app/pages/settings.vue:41`

Navbar가 `absolute` 오버레이이므로 본문이 헤더 높이를 비우지 않습니다. 320·375·480·639px에서 버튼 라벨 18px가 Navbar 밴드(16-80px) 아래에 들어갑니다. 클릭은 Navbar로 전달되어 "← 뒤로 돌아가기"를 누를 수 없습니다. 640px부터는 `sm:` 단위로 본문 여백이 늘면서 문제가 사라집니다.

채팅 화면은 `packages/chat-app/app/pages/chat/[id].vue:202`에서 `pt-(--ui-header-height)`로 이 문제를 이미 피하고 있습니다. 설정 화면도 같은 값을 씁니다.

### 설정 화면의 섹션 nav

`packages/chat-app/app/pages/settings.vue:53`

`md:top-0`이 스크롤 컨테이너 기준이라 Navbar 높이를 고려하지 않습니다. 본문을 300px 내리면 nav가 40px 지점에 멈춰 "화면 설정" 항목 40px가 Navbar 아래에 들어갑니다. 1024·1280·1440×900에서 재현됩니다. 클릭은 Navbar로 전달됩니다.

`md:top-(--ui-header-height)`로 바꿉니다.

### 스킬 화면의 버튼 넘침

`packages/chat-app/app/components/SkillSettings.vue:228`

320px에서 "SKILL.md / ZIP 가져오기"와 "새 스킬" 버튼이 한 줄에 고정되어 332px까지 나갑니다. "새 스킬" 버튼 12px가 화면 밖으로 잘리고 설정 본문이 가로로 12px 스크롤됩니다. 다른 설정 화면에서는 같은 넘침이 없었습니다.

버튼 묶음에 `flex-wrap`을 넣고 라벨을 줄입니다.

## MEDIUM

### 홈 화면 제목

`packages/chat-app/app/pages/index.vue:104`

`justify-center`로 세로 중앙 정렬한 제목이 짧은 뷰포트에서 Navbar 위로 올라갑니다. 320×480에서 32px, 320×568에서 20px, 375×600에서 4px가 가려집니다. 320×480은 본문을 끝까지 내려도 제목이 다시 보이지 않습니다.

상단 여백에 헤더 높이를 반영합니다.

### 프롬프트 푸터 줄바꿈

`packages/chat-app/app/components/chat/Prompt.vue:204`, `:218`

푸터가 320·360·375px에서 3행(96px), 414px에서 2행(64px), 480px 이상에서 1행(28px)이 됩니다. 320px에서는 모델 선택 버튼이 첫 줄의 파일 추가 버튼과 어긋납니다. 물리 마진 `ml-auto`가 논리 마진 `ms-auto`와 바뀌어야 RTL에서도 같은 줄을 유지합니다.

### 물리 방향 속성

`packages/chat-app/app/layouts/default.vue:209`

`ml-4`과 `rounded-tl-lg`가 물리 방향입니다. `dir="rtl"`을 주입하면 패널 위치는 좌우로 바뀌지만 모서리 라운드는 왼쪽에 남습니다. `ms-4`와 `rounded-ss-lg`로 바꿉니다.

`packages/chat-app/app/layouts/default.vue:132`, `:138`, `:157`

이름 변경·삭제 아이콘이 `translate-x-full`로 대기하다 호버 시 들어옵니다. `translateX`에는 논리 대응이 없어 RTL에서 방향이 뒤집히지 않습니다. `pr-14.5` 예약 폭도 물리 값입니다. `pe-14.5`와 `rtl:translate-x-[-100%]`로 바꿉니다.

## LOW

### 설정 화면 기준선

`packages/chat-app/app/pages/settings.vue:41`

Navbar의 "설정" 제목과 본문 첫 열이 어긋납니다. 1024·1280·1440px에서 40px, 1920px에서 273px 차이 납니다. 본문이 `max-w-6xl` 중앙 정렬인 반면 제목은 고정 오프셋이라 기준선이 둘입니다.

## 이상 없음

- 가로 스크롤: 320px에서 `document.documentElement.scrollWidth`와 `clientWidth`가 같습니다.
- 채팅 메시지 액션 버튼: 다음 메시지와 겹치지 않습니다.
- 마지막 메시지와 프롬프트: 320px에서 32px 간격입니다.
- 모델 선택 드롭다운: 320px에서 `max-w-[calc(100vw-2rem)]`이 화면 안에 들어갑니다.
- 사이드바 액션 아이콘: 호버 시 링크 경계 밖으로 나가지 않습니다.
- `100vw`·`100vh`·`dvh`·`minmax(0,1fr)`·`@container`·`safe-area` 패턴: 코드에 없습니다.
- `viewport-fit=cover`와 `env(safe-area-inset-*)`는 함께 쓰이지 않습니다.
