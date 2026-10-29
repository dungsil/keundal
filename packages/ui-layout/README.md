# @keundal/ui-layout

본문 틀을 `app.layout` 슬롯에 등록하는 UI 플러그인입니다. 본문으로 건너뛰기 링크, `main#main-content`와 경로 페이지를 그립니다. 경로를 이동하면 `main`으로 초점을 옮깁니다. 시작 화면과 전역 메타데이터는 `@keundal/ui-shell`, 사이드바의 표시와 닫기는 `@keundal/ui-sidebar`가 담당합니다.

선언하는 슬롯은 다음과 같습니다.

| 슬롯                                                      | 종류     | 내용                                   |
| --------------------------------------------------------- | -------- | -------------------------------------- |
| `page.home`, `page.chat`, `page.history`, `page.settings` | `single` | `chat-app`의 경로 페이지가 그리는 화면 |
| `layout.navigation`                                       | `single` | 사이드바를 등록하는 위치               |
| `layout.overlay`                                          | `list`   | 페이지 옆에 두는 대화상자              |

소유자 값의 타입은 `@keundal/ui/app/contracts/layout.ts`에 있습니다.
