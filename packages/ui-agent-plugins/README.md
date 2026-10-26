# @keundal/ui-agent-plugins

설정 페이지에 큰달 플러그인과 에이전트 플러그인 관리 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키                | 순서 | 설명                                                                      |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------------- |
| `settings.section` | `runtime-plugins` | 90   | 앱에 포함된 선택 기능의 활성화·비활성화와 필수 서비스 표시                |
| `settings.section` | `plugins`         | 100  | `/settings/plugins`의 플러그인 폴더 가져오기, 활성화, MCP 권한 설정, 삭제 |

섹션은 브라우저에서만 렌더링하므로 `ClientOnly`로 감쌉니다. **에이전트 플러그인**(영문 **Agent plugins**)은 `ctx.chatRuntime.platform.plugins`의 `list`·`import`·`configure`·`remove`를 콜백으로 받습니다. 큰달 플러그인 섹션은 셸이 조립한 `ctx.chatRuntime.pluginManager`의 `list`와 `setEnabled`만 받습니다. 이 목록에는 정적으로 번들된 필수 서비스인 LLM·저장소·에이전트와 선택 기능인 스킬·MCP·날씨·차트 도구만 표시합니다. `ui-*` 행이나 별도 화면 스위치, 외부 설치·다운로드 입력란은 제공하지 않습니다. 변경 전에는 진행 중인 응답을 중단하고, 필수 서비스는 끌 수 없도록 표시합니다. 이 슬롯 외에 선언하는 슬롯은 없습니다.

스킬·MCP와 해당 화면의 수명은 셸이 함께 관리합니다. `@keundal/plugin-skill`을 끄면 `@keundal/ui-skill`, `@keundal/plugin-mcp-client`를 끄면 `@keundal/ui-mcp`도 해제합니다. 다시 켜면 해당 UI를 등록하며, 스킬·MCP 탐색 항목도 함께 복원합니다. 이 관리 화면을 포함한 나머지 UI는 항상 등록합니다.

`@keundal/plugin-tool-chat`을 끄면 이후 실행 목록에서 날씨·차트 도구를 제외하지만 `@keundal/ui-tool`은 유지합니다. 이 UI는 `@keundal/ui-chat`처럼 공유 메시지 표시를 담당하며, 날씨·차트뿐 아니라 `delegate_task`, `skill`, `web_search`, `google_search` 결과도 표시합니다. 기존 대화 기록과 다른 선택 기능의 결과를 계속 표시해야 하므로 별도로 끄고 켜는 UI 스위치는 제공하지 않습니다.

선택 저장은 실행 방식의 관리자가 담당합니다. web의 `BrowserRuntimePluginManager`는 기존 `keundal:bundled-plugins` localStorage를 사용하고 desktop은 기존 네이티브 저장소를 사용합니다. `keundal-ui-plugins` 쿠키는 선택에 영향을 주지 않습니다. 서버 렌더링과 최초 하이드레이션은 기본 UI를 등록하며, 앱이 마운트된 뒤 실제 기능 선택과 동기화합니다.

web과 desktop의 적용 방식은 [플러그인 조립 문서](../../docs/plugin-composition.md#ui에서-선택-기능-관리)를 참고합니다.

## 구성

- `app/lib/plugin-import.ts`: 선택한 폴더에서 `plugin.json`, `mcp.json`, `skills/*/SKILL.md`만 읽습니다. 텍스트 파일 합계는 4 MiB까지 허용합니다.
- `tests/agent-plugins.test.ts`: 폴더 가져오기와 브라우저 플러그인 관리자의 동작을 검증합니다.

```ts
import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'

ctx.plugin(agentPlugins)
```
