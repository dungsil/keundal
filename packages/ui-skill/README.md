# @keundal/ui-skill

설정 페이지에 스킬 관리 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키       | 순서 | 설명                                                                            |
| ------------------ | -------- | ---- | ------------------------------------------------------------------------------- |
| `settings.section` | `skills` | 110  | `/settings/skills`의 스킬 목록·편집, SKILL.md·ZIP 가져오기, 로컬 스킬 파일 목록 |

섹션은 `ctx.chatRuntime.platform.skills`의 `load`·`save`·`listFiles`를 콜백으로 받습니다. 플랫폼은 브라우저에서만 존재하므로 콜백이 실행될 때 접근합니다. 이 슬롯 외에 선언하는 슬롯은 없습니다.

## 구성

- `app/lib/skill-import.ts`: SKILL.md 또는 ZIP 파일을 스킬 정의로 변환합니다. ZIP은 10 MiB, SKILL.md는 1 MiB까지 허용합니다.
- `tests/skill-import.test.ts`: 가져오기 규칙을 검증합니다.

```ts
import * as skill from '@keundal/ui-skill/plugin'

ctx.plugin(skill)
```
