# @keundal/ui-agent-plugins

설정 페이지에 큰달 플러그인과 에이전트 플러그인 관리 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키                | 순서 | 설명                                                                      |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------------- |
| `settings.section` | `runtime-plugins` | 90   | 앱에 포함된 선택 기능의 활성화·비활성화와 필수 서비스 표시                |
| `settings.section` | `plugins`         | 100  | `/settings/plugins`의 플러그인 폴더 가져오기, 활성화, MCP 권한 설정, 삭제 |

섹션은 브라우저에서만 렌더링하므로 `ClientOnly`로 감쌉니다. **에이전트 플러그인**(영문 **Agent plugins**)은 `ctx.chatRuntime.platform.plugins`의 `list`·`import`·`previewUpdate`·`update`·`configure`·`remove`를 콜백으로 받습니다. 큰달 플러그인 섹션은 셸이 조립한 `ctx.chatRuntime.pluginManager`의 실행·UI 목록과 선택 변경을 콜백으로 받습니다. 설치 기능이 있는 desktop에서는 npm·JSR·로컬 ZIP·경로 등록과 외부 항목 삭제도 제공합니다. web에는 설치 입력란을 표시하지 않습니다. 변경 전에는 진행 중인 응답을 중단합니다. 이 슬롯 외에 선언하는 슬롯은 없습니다.

에이전트 플러그인의 **폴더에서 업데이트**는 같은 이름의 폴더를 선택한 뒤 설치된 버전과 새 버전, 추가·변경·삭제된 파일의 내용을 보여 줍니다. 검토 중에는 설치된 내용을 바꾸지 않습니다. 활성화 설정과 변경되지 않은 MCP 연결의 권한은 유지합니다. 추가된 서버나 URL·헤더가 바뀐 서버는 권한을 다시 입력해야 하며, 비워 두면 접근을 거부합니다. 서버 연결이나 도구 실행 없이 검토하며, 잘못된 스킬·MCP 설정은 진단을 해결하기 전까지 적용하지 못합니다.

적용할 때는 진행 중인 응답을 중단하고 MCP 연결을 정리한 뒤 파일과 권한을 한 번에 저장합니다. 검증·응답 중단·저장에 실패하면 기존 버전과 설정을 유지하며 다음 응답에서 기존 MCP 연결을 다시 엽니다. 검토 후 설정이나 설치 목록을 바꾸면 다시 검토해야 합니다. 취소하면 설치된 내용과 실행 중인 응답을 그대로 둡니다. 버전 문자열은 표시용이며 같은 버전의 수정본도 파일이 다르면 적용할 수 있습니다.

번들된 실행·UI 플러그인을 모두 표시하고 각각 선택할 수 있습니다. 필수 서비스인 LLM·저장소와 선택을 복구하는 관리 셸인 `@keundal/ui-layout`, `@keundal/ui-settings`, `@keundal/ui-agent-plugins`만 끌 수 없습니다. 채팅 에이전트를 끄면 새 응답을 막되 기존 세션과 기능 목록·관리 화면은 유지합니다.

각 항목의 `requires`를 **의존 대상**(Requires)으로, 역방향 관계를 **사용하는 플러그인**(Used by)으로 표시합니다. 스킬·MCP UI는 각각 `@keundal/plugin-skill`·`@keundal/plugin-mcp-client`에 의존합니다. 의존 대상을 끄면 해당 UI와 탐색 항목을 해제하지만 저장한 활성화 선택은 유지합니다. 다시 켜면 활성화해 둔 UI만 복원하며, 직접 끈 UI는 꺼진 상태를 유지합니다.

`@keundal/prompt`와 `@keundal/subagent` 항목은 새 구현 플러그인 패키지가 아니라 공통 에이전트 루프의 내장 기능을 제어합니다. `@keundal/ui-settings-llm/prompt-plugin`과 `@keundal/ui-subagents`는 각각 이 기능에 의존합니다. 프롬프트 UI는 LLM 공급자 설정 UI와 독립적으로 선택합니다.

`@keundal/plugin-tool-chart`와 `@keundal/plugin-tool-weather`를 끄면 이후 실행 목록에서 해당 도구만 제외합니다. 결과를 표시하는 `@keundal/ui-chart`, `@keundal/ui-weather`, `@keundal/ui-tool`도 각각 끄고 켤 수 있지만 실행 도구에는 의존하지 않습니다. UI를 따로 끄지 않으면 기존 차트·날씨와 `delegate_task`, `skill`, `web_search`, `google_search` 결과를 계속 표시합니다.

실행 선택의 저장은 실행 방식의 관리자가 담당합니다. web의 `BrowserRuntimePluginManager`는 기존 `keundal:bundled-plugins` localStorage를 사용하고 desktop은 기존 네이티브 저장소와 이전 선택 형식을 유지·이전합니다. desktop의 실행 선택 변경은 sidecar를 다시 시작합니다. UI 선택은 브라우저 localStorage의 `keundal:ui-plugin-selections`에 저장합니다. `keundal-ui-plugins` 쿠키는 선택에 영향을 주지 않습니다. 서버 렌더링과 최초 하이드레이션은 기본 UI를 등록하며, 앱이 마운트된 뒤 저장한 선택과 의존 상태를 동기화합니다.

`platform.runtimePlugins`가 없는 원격 연결에서도 로컬 UI 목록과 선택은 제공합니다. 서버의 실행 기능이나 설치 상태는 바꾸지 않습니다.

web과 desktop의 적용 방식은 [플러그인 조립 문서](../../docs/plugin-composition.md#ui에서-선택-기능-관리)를 참고합니다.

## 구성

- `app/lib/plugin-import.ts`: 선택한 폴더에서 `plugin.json`, `mcp.json`, `skills/*/SKILL.md`만 읽습니다. 텍스트 파일 합계는 4 MiB까지 허용합니다.
- `tests/agent-plugins.test.ts`: 폴더 가져오기와 브라우저 플러그인 관리자의 동작을 검증합니다.

```ts
import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'

ctx.plugin(agentPlugins)
ctx.plugin(agentPlugins.agentPluginSettings)
```
