# @keundal/ui-mcp

설정 페이지에 MCP 서버 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키    | 순서 | 설명                                                                    |
| ------------------ | ----- | ---- | ----------------------------------------------------------------------- |
| `settings.section` | `mcp` | 120  | `/settings/mcp`의 서버 목록·편집, 연결 확인, 허용 도구·리소스 권한 설정 |

섹션은 `ctx.chatRuntime`에서 기능(`capabilities`)과 원격 에이전트 여부(`remoteAgent`)를 값으로 받고, 서버 구성 조회, 저장(`saveMcpSettings`), 연결 확인(`platform.mcp.probe`)을 콜백으로 받습니다. 플랫폼은 브라우저에서만 존재하므로 콜백이 실행될 때 접근합니다. 이 슬롯 외에 선언하는 슬롯은 없습니다.

```ts
import * as mcp from '@keundal/ui-mcp/plugin'

ctx.plugin(mcp)
```
