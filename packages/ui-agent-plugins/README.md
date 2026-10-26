# @keundal/ui-agent-plugins

설정 페이지에 큰달 플러그인과 에이전트 플러그인 관리 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키                | 순서 | 설명                                                                      |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------------- |
| `settings.section` | `runtime-plugins` | 90   | 앱에 포함된 화면·실행 기능의 활성화·비활성화와 필수 항목 표시             |
| `settings.section` | `plugins`         | 100  | `/settings/plugins`의 플러그인 폴더 가져오기, 활성화, MCP 권한 설정, 삭제 |

섹션은 브라우저에서만 렌더링하므로 `ClientOnly`로 감쌉니다. Agent Plugins는 `ctx.chatRuntime.platform.plugins`의 `list`·`import`·`configure`·`remove`를 콜백으로 받습니다. 큰달 플러그인 섹션은 셸이 조립한 `ctx.chatRuntime.pluginManager`의 `list`와 `setEnabled`만 받습니다. 이 목록은 정적으로 번들된 패키지로 제한하며 외부 설치·다운로드 입력란은 제공하지 않습니다. 변경 전에는 진행 중인 응답을 중단하고, 필수 항목은 끌 수 없도록 표시합니다. 이 슬롯 외에 선언하는 슬롯은 없습니다.

web과 desktop의 적용 방식은 [플러그인 조립 문서](../../docs/plugin-composition.md#ui에서-선택-기능-관리)를 참고합니다.

## 구성

- `app/lib/plugin-import.ts`: 선택한 폴더에서 `plugin.json`, `mcp.json`, `skills/*/SKILL.md`만 읽습니다. 텍스트 파일 합계는 4 MiB까지 허용합니다.
- `tests/agent-plugins.test.ts`: 폴더 가져오기와 브라우저 플러그인 관리자의 동작을 검증합니다.

```ts
import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'

ctx.plugin(agentPlugins)
```
