# @keundal/ui-settings-llm

설정 페이지에 LLM 공급자 섹션과 시스템 프롬프트 섹션을 추가하는 UI 플러그인입니다. Nuxt 레이어이면서 Cordis 플러그인이며, `ctx.slots`와 `ctx.chatRuntime`에 의존합니다.

## 등록하는 슬롯

| 슬롯               | 키              | 순서 | 설명                                                                                           |
| ------------------ | --------------- | ---- | ---------------------------------------------------------------------------------------------- |
| `settings.section` | `llm`           | 10   | `/settings/llm`의 공급자 목록, API 키·주소·요청 헤더 편집. `?provider=`로 공급자를 지정합니다. |
| `settings.section` | `system-prompt` | 25   | `/settings/system-prompt`에서 모든 대화에 적용할 지침을 입력하고 저장합니다.                   |

공급자 섹션은 `ctx.chatRuntime`에서 저장된 설정(`settings`), 선택한 모델(`model`), 기능(`capabilities`)을 받습니다. 저장할 때 `store.stop()`으로 진행 중인 응답을 멈춘 뒤 `saveSettings()`를 호출합니다. 이 두 항목 외에 선언하는 슬롯은 없습니다.

시스템 프롬프트는 `systemPrompt`와 `saveSystemPrompt()`를 받습니다. 저장한 지침은 이 기기의 `localStorage`에 보관하며 계정과 동기화하지 않습니다. 다음 응답부터 기본 지침에 추가하고, 이미 실행 중인 응답과 제목 생성에는 적용하지 않습니다. 입력란을 비우고 저장하면 사용자 지침을 삭제하고 기본 지침만 사용합니다.

```ts
import * as llm from '@keundal/ui-settings-llm/plugin'

ctx.plugin(llm)
```
