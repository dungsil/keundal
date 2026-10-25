# @keundal/ui-agent-plugins

설정 페이지에 큰달 플러그인과 에이전트 플러그인 관리 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키                | 순서 | 설명                                                                      |
| ------------------ | ----------------- | ---- | ------------------------------------------------------------------------- |
| `settings.section` | `runtime-plugins` | 90   | Cordis 모듈 설치, 활성화·비활성화, 오류 확인, 삭제                        |
| `settings.section` | `plugins`         | 100  | `/settings/plugins`의 플러그인 폴더 가져오기, 활성화, MCP 권한 설정, 삭제 |

섹션은 브라우저에서만 렌더링하므로 `ClientOnly`로 감쌉니다. `ctx.chatRuntime.platform.plugins`의 `list`·`import`·`configure`·`remove`를 콜백으로 받으며, 변경 전에는 `store.stop()`으로 진행 중인 응답을 멈춥니다. 큰달 플러그인 섹션은 별도의 `runtimePlugins` 계약을 사용합니다. 모듈의 내보내기 이름과 JSON 설정을 입력하고 출처·권한을 확인한 뒤 설치하며, 설치 직후에는 비활성 상태입니다. 연결이 플러그인 관리를 지원하지 않으면 안내 문구만 표시합니다. 이 슬롯 외에 선언하는 슬롯은 없습니다.

web과 desktop의 설치 형식과 권한은 [플러그인 조립 문서](../../docs/plugin-composition.md#ui에서-선택-기능-관리)를 참고합니다.

## 구성

- `app/lib/plugin-import.ts`: 선택한 폴더에서 `plugin.json`, `mcp.json`, `skills/*/SKILL.md`만 읽습니다. 텍스트 파일 합계는 4 MiB까지 허용합니다.
- `tests/agent-plugins.test.ts`: 폴더 가져오기와 브라우저 플러그인 관리자의 동작을 검증합니다.

```ts
import * as agentPlugins from '@keundal/ui-agent-plugins/plugin'

ctx.plugin(agentPlugins)
```
