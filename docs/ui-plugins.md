# UI 플러그인과 슬롯

채팅 화면은 `packages/ui-*` 플러그인의 조합으로 만든다. 각 플러그인은 Nuxt 레이어이면서 Cordis 플러그인이다. Nuxt 레이어는 앱의 모듈, Tailwind, 아이콘 설정으로 플러그인의 컴포넌트를 컴파일한다. Cordis 플러그인의 `apply(ctx)`는 컴포넌트를 슬롯에 등록한다. `@keundal/chat-app`은 셸, 경로 페이지, 플러그인 조립만 담당한다.

## 구성 요소

| 패키지                | 역할                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `@keundal/ui-slots`   | 슬롯 레지스트리 `ctx.slots`와 `SlotRoot`, `SlotOutlet`, `SlotFactory`, `useSlotEntries`를 제공합니다. |
| `@keundal/ui-runtime` | 채팅 플랫폼 연결과 플러그인 사이에서 공유하는 화면 상태를 `ctx.chatRuntime`으로 제공합니다.           |
| `@keundal/ui`         | 공통 컴포넌트, 공유 사전, `defineMessages`, `useChatActions`, `useFileUploadWithStatus`를 제공합니다. |
| `@keundal/ui-*`       | 화면 기능 하나를 슬롯에 등록합니다.                                                                   |
| `@keundal/chat-app`   | `app/plugins/ui.ts`에서 Cordis `Context`를 만들고 `app/ui-plugins.ts`의 플러그인을 등록합니다.        |

`app/plugins/ui.ts`는 서버 렌더링과 최초 하이드레이션에서 같은 기본 UI를 등록합니다. `ChatRuntime.start()`는 브라우저에서만 플랫폼을 연결하며, 앱이 마운트된 뒤 실제 실행 방식의 선택과 UI를 동기화합니다. 저장된 선택에서 기능을 꺼 두었어도 하이드레이션이 끝나기 전에는 기본 UI를 유지합니다. 이전 `keundal-ui-plugins` 쿠키는 읽거나 선택에 반영하지 않습니다. 플랫폼이 필요한 멤버는 연결하기 전에 호출하면 예외를 던집니다.

`UIPluginManager`는 UI의 Cordis 등록 범위를 소유하지만 독립적인 UI 선택은 제공하지 않습니다. **설정 → 큰달 플러그인**에는 실행 방식이 제공하는 필수 서비스인 LLM·저장소·에이전트와 선택 기능인 스킬·MCP·날씨·차트 도구만 표시합니다. `ui-*`는 행이나 스위치로 표시하지 않습니다. `ChatRuntime.pluginManager`도 이 기능 목록만 제공하며, `platform.runtimePlugins`가 있을 때만 노출합니다. 원격 연결처럼 실행 방식의 관리자가 없으면 관리 화면은 사용할 수 없음을 표시하고 기본 UI를 유지합니다.

| 선택 기능 모듈               | 함께 등록·해제하는 UI |
| ---------------------------- | --------------------- |
| `@keundal/plugin-skill`      | `@keundal/ui-skill`   |
| `@keundal/plugin-mcp-client` | `@keundal/ui-mcp`     |

선택 기능을 끄기 전에는 진행 중인 응답을 중단합니다. 스킬·MCP를 끄면 대응하는 UI 범위도 해제하고, 켜면 다시 등록합니다. 해당 설정 화면·탐색 항목도 함께 사라지거나 복원됩니다. 나머지 UI는 화면 셸·설정·관리 화면을 포함해 항상 등록합니다. Nuxt 레이어는 정적으로 빌드하며, 외부 모듈을 내려받거나 빌드하지 않습니다.

`@keundal/ui-tool`은 `delegate_task`, `skill`, `web_search`, `google_search` 결과를, `@keundal/ui-chart`와 `@keundal/ui-weather`는 차트와 날씨 결과를 표시합니다. 세 UI는 기존 대화 기록을 표시해야 하므로 `@keundal/ui-chat`처럼 항상 등록합니다. `@keundal/plugin-tool-chart`와 `@keundal/plugin-tool-weather`를 각각 끄면 이후 실행 목록에서 해당 도구만 제외하며, 기존 결과를 표시하는 UI는 해제하지 않습니다. 공유 UI를 별도로 끄고 켜는 스위치는 없습니다.

선택은 실행 방식의 관리자가 저장합니다. web의 `BrowserRuntimePluginManager`는 기존 `keundal:bundled-plugins` localStorage를 사용하고 desktop은 기존 네이티브 저장소를 사용합니다. UI 관리자는 선택을 별도로 저장하지 않습니다.

## 슬롯 선언

슬롯은 등록할 위치를 소유한 항목이 선언합니다. 항목은 `register()`의 `children`에 하위 슬롯과 종류를 적고, 같은 이름을 `SlotMap`에 선언 병합합니다. 선언은 렌더링 권한도 함께 정합니다. 항목은 자신이 선언한 슬롯만 `SlotOutlet`으로 그릴 수 있습니다.

```ts
declare module '@keundal/ui-slots' {
  interface SlotMap {
    'chat.message.tool': { kind: 'keyed'; owner: ChatToolOwner }
  }
}

ctx.slots.register({ name: 'page.chat', children: { 'chat.message.tool': 'keyed' } }, ChatPage)
```

| 종류     | 그리는 항목                                                                   |
| -------- | ----------------------------------------------------------------------------- |
| `single` | 우선순위가 가장 낮은 항목 하나를 그립니다.                                    |
| `list`   | `id`마다 하나씩 `order` 순서로 모두 그립니다.                                 |
| `keyed`  | 소유자가 `entry-key`로 고른 `key`의 항목을 그립니다.                          |
| `chain`  | 우선순위 순서로 `select(owner)`를 실행하고, 처음 값을 돌려준 항목을 그립니다. |

같은 칸에 우선순위가 다른 항목을 등록하면 낮은 값이 높은 값을 가립니다. 같은 우선순위로 같은 칸에 등록하면 레지스트리가 예외를 던집니다. `root`만 레지스트리에 미리 선언되어 있습니다.

다른 플러그인이 선언하는 슬롯에는 `ctx.slots.inject(name, callback)`으로 등록합니다. 레지스트리는 선언이 생길 때마다 `callback`을 실행합니다. 선언한 항목이 해제되면 `callback`이 돌려준 해제 함수를 실행합니다. 그래서 플러그인을 등록하는 순서와 상관없이 같은 화면을 만듭니다.

소유자 둘 이상이 같은 조합을 그릴 때는 팩터리를 씁니다. `registerFactory()`로 정의를 하나 등록하고, 어느 항목에서나 `SlotFactory`로 그립니다. 팩터리의 하위 슬롯은 팩터리 정의가 선언합니다. 입력란 `composer`가 팩터리이며, 새 대화 페이지와 대화 페이지가 함께 그립니다.

## 컴포넌트 입력

컴포넌트는 `ctx`, Cordis 서비스, `useNuxtApp()`의 플랫폼 객체를 받지 않습니다. 컴포넌트가 받는 값은 다음 두 가지입니다.

- 소유자가 `SlotOutlet`의 `owner`로 전달한 값
- 등록의 `inject` 함수가 돌려준 값

`inject` 함수는 항목을 마운트할 때 한 번 실행합니다. 이 함수는 플러그인의 `apply` 안에서 정의하므로 주입한 서비스를 사용할 수 있습니다. 반환 값에는 컴포넌트에 필요한 ref와 묶은 콜백만 넣습니다. 서비스 전체, `ctx`, `runtime.store` 같은 객체는 넣지 않습니다. 소유자 값과 이름이 겹치면 현재 소유자 값을 씁니다. 렌더러는 컴포넌트가 `props`로 선언한 값만 전달합니다.

컴포넌트를 `lazyView(load, props)`로 등록하면 첫 렌더링 때 별도 스크립트로 내려받습니다. 그래야 첫 화면이 모든 화면의 코드를 함께 받지 않습니다. `props`에는 렌더러가 전달할 값의 이름을 소유자 값과 `inject` 결과에서 모아 적습니다. 렌더러는 이 이름으로 값을 거르므로, 빠진 이름은 컴포넌트에 전달되지 않습니다.

같은 플러그인의 두 항목이 화면 상태를 공유할 때는 `apply` 안에서 반응형 상태를 만들고 두 `inject` 함수가 함께 돌려줍니다. `useRoute`, `navigateTo`, `useToast` 같은 Nuxt와 Vue의 컴포저블은 컴포넌트에서 계속 사용합니다.

항목의 컴포넌트가 오류를 던지면 렌더러는 오류를 기록하고 그 항목만 비웁니다.

## 번역

각 패키지는 `app/locales/{en,ko}.ts`에 자신이 쓰는 문구를 둡니다. `app/locale.ts`의 `useText()`는 패키지의 키를 먼저 찾고, 없으면 `@keundal/ui`의 공유 사전에서 찾습니다. 패키지 둘 이상이 쓰는 문구와 셸의 문구는 공유 사전에 둡니다. 다른 컴포넌트가 읽는 메타데이터의 문구는 `localizedText()`나 `sharedText()`로 모든 언어의 값을 함께 넘깁니다.

큰달 플러그인 목록의 이름과 설명은 각 기능 패키지가 내보내는 `metadata`를 사용합니다. `name`과 `description`은 각각 `{ en: string, ko: string }`으로 제공합니다. 앱의 조립 계층은 이를 `RuntimePluginInfo.metadata`에 담고, 화면은 현재 앱 언어의 이름·설명과 스위치의 접근성 이름을 표시합니다. `module`은 선택과 저장에 쓰는 식별자로 유지합니다. 메타데이터가 없는 항목은 `module`을 이름으로 표시하며 설명은 생략합니다. desktop의 외부 설치 항목은 `package.json`의 이름·설명·버전을 사용하며, 표시를 위해 외부 모듈을 불러오지 않습니다. 설치·삭제 콜백은 desktop의 관리자가 제공할 때만 노출합니다.

화면은 태그라인과 상시 도움말 대신 제목, 입력란 이름, 구분선과 컨트롤 배치로 구조를 전달합니다. 중복되는 보조 레이블은 표시하지 않습니다. 오류, 보안 경고, 사용자가 작성한 내용과 접근성 이름은 유지합니다.

## 패키지 구조

```text
packages/ui-<name>/
  nuxt.config.ts     빈 Nuxt 레이어
  app/plugin.ts      Cordis 플러그인: name, inject, apply
  app/slots.ts       이 패키지가 선언하는 슬롯과 소유자 타입
  app/views/*.vue    등록하는 컴포넌트
  app/lib/*.ts       명시적으로 가져오는 순수 함수
  app/locale.ts      useText()
```

Nuxt는 레이어의 `components`, `composables`, `utils`, `plugins`, `pages`, `layouts`, `middleware` 디렉터리를 전역으로 등록합니다. 플러그인 패키지는 이 디렉터리를 만들지 않습니다. 번들 목록에 패키지를 추가하거나 빼려면 `packages/chat-app/app/ui-plugins.ts`의 `uiPluginCatalog`와 `nuxt.config.ts`의 `extends`를 함께 고칩니다.

## 슬롯 구조

```text
root                               ui-layout
├─ page.home                       ui-home
├─ page.history                    ui-chat-list
├─ page.chat                       ui-chat
│  ├─ chat.message.tool            ui-tool, ui-chart, ui-weather (항목이 없으면 기본 도구 카드)
│  ├─ chat.message.footer          ui-trace
│  ├─ chat.indicator               ui-trace
│  └─ chat.observer                ui-trace
├─ page.settings                   ui-settings
│  └─ settings.section             ui-settings, ui-settings-llm, ui-model-selection,
│                                  ui-agent-plugins, ui-skill, ui-mcp
├─ layout.sidebar                  ui-chat-list
├─ layout.sidebar.footer           ui-settings
└─ layout.overlay                  ui-chat-list

factory composer                   ui-composer
├─ composer.actions                ui-model-selection
└─ composer.dictation              ui-dictation (항목이 없으면 전송 버튼)
```

각 슬롯의 소유자 값은 선언한 패키지의 `app/slots.ts`에서 확인합니다.
