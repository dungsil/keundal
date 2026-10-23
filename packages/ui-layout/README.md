# @keundal/ui-layout

앱의 기본 틀을 `root` 슬롯에 등록하는 UI 플러그인입니다. 본문으로 건너뛰기 링크, 접을 수 있는 사이드바, `main#main-content`와 경로 페이지를 그립니다. 경로를 이동하면 사이드바를 닫고 `main`으로 초점을 옮깁니다.

선언하는 슬롯은 다음과 같습니다.

| 슬롯                                      | 종류     | 내용                                   |
| ----------------------------------------- | -------- | -------------------------------------- |
| `page.home`, `page.chat`, `page.history`, `page.settings` | `single` | `chat-app`의 경로 페이지가 그리는 화면 |
| `layout.sidebar`                          | `list`   | 사이드바 본문                          |
| `layout.sidebar.footer`                   | `list`   | 사이드바 아래쪽                        |
| `layout.overlay`                          | `list`   | 페이지 옆에 두는 대화상자              |

소유자 값의 타입은 `app/slots.ts`에 있습니다.
