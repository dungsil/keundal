# 계약과 구현 플러그인을 분리하고 앱이 조립한다

계약과 실행 정책의 패키지 소유권은 [ADR-0005](0005-service-package-boundaries.md)에서 세분화한다. 아래 플랫폼별 조립과 수명 규칙은 유지한다.

`@keundal/agent`, `tools`, `context`, `mcp`, `shell`, `transcription`, `fs`는 서비스 계약만 제공한다. 구현은 `plugin-*` 패키지에 두고, 공통 실행 루프와 축약·도구 정책은 `agent-loop`가 소유한다. 앱의 `app/platform.ts`가 실행 환경과 기본 플러그인 목록을 정한다. 계약 패키지와 공통 UI는 구현 패키지를 실행 의존성으로 가져오지 않으며, `pnpm check:boundaries`가 이를 검사한다.

필수 서비스의 구현은 런타임 매니페스트로 고른다. web은 `/keundal.plugins.json`을 기본으로 읽고 `NUXT_PUBLIC_PLUGIN_CONFIG`로 다른 URL을 지정한다. Node.js 호스트와 desktop은 `KEUNDAL_PLUGIN_CONFIG`, 앱 데이터 디렉터리, 현재 디렉터리 순서로 설정 파일을 찾는다. 배포 설정이나 모듈이 잘못되면 기본 구성으로 대체하지 않고 시작을 거부한다.

선택 기능은 **설정 → 큰달 플러그인**에서 활성화·비활성화한다. web은 앱에 함께 패키징한 기능 모듈만 제공한다. desktop은 여기에 npm·JSR 패키지와 로컬 ZIP·경로의 큰달 플러그인을 추가할 수 있다. 외부 설치는 배포 매니페스트와 분리하며, 이전의 외부 모듈 선택을 자동으로 가져오지는 않는다. web은 실행 기능의 선택을 바로 반영하고 desktop은 실행 기능의 선택 변경 후 sidecar를 다시 시작한다. 변경 전에는 진행 중인 응답을 중단하며, 비활성화는 사용자 데이터를 삭제하지 않는다.

desktop은 npm을 앱에 포함하고 설치 스크립트를 실행하지 않는다. 패키지와 ZIP은 전용 디렉터리에 의존성과 함께 설치하며, JavaScript 파일 경로는 원본을 참조한다. 외부 코드는 설치 직후에는 실행하지 않고, 사용자가 활성화할 때 기본 내보내기를 Cordis 플러그인으로 등록한다. 활성화 오류는 관리 화면에 표시하고 이전 선택을 복구한다. 플러그인은 호스트 권한으로 실행되므로 설치 화면에서 신뢰 여부를 확인한다. 삭제할 때는 관리하는 복사본만 지우고 원본 경로와 대화 기록은 유지한다.

선택 기능의 목록은 배포 매니페스트와 분리한다. 실행 목록과 UI 목록을 함께 표시하고 번들된 실행·UI 플러그인을 모두 관리한다. 필수 서비스인 LLM·저장소와 선택을 복구하는 관리 셸인 `@keundal/ui-shell`, `@keundal/ui-sidebar`, `@keundal/ui-settings`, `@keundal/ui-agent-plugins`만 끌 수 없다. 채팅 에이전트는 선택 기능이며, 끄면 새 응답을 막되 기존 세션과 기능 목록·관리 화면은 유지한다. desktop에서는 사용자가 설치한 외부 항목도 추가한다. 각 앱이 `nuxt.config.ts`의 `extends`와 `app/ui-plugins.ts`에서 UI를 직접 조립하고, 공통 초기화와 UI 선택 관리는 `@keundal/ui-runtime`이 담당한다. Nuxt 레이어는 UI 선택과 관계없이 빌드에 유지한다.

항목의 `requires`로 의존 대상을 선언하고 관리 화면에는 **의존 대상**(Requires)과 역방향의 **사용하는 플러그인**(Used by)을 표시한다. 스킬·MCP UI는 각각 실행 기능에 의존한다. 의존 대상을 끄면 UI의 Cordis 등록 범위와 탐색 항목을 해제하되 저장한 활성화 선택은 유지한다. 의존 대상을 복원하면 활성화해 둔 UI만 다시 등록하며, 사용자가 직접 끈 UI는 꺼진 상태를 유지한다.

`@keundal/prompt`와 `@keundal/subagent` 항목은 새 구현 플러그인이 아니라 공통 에이전트 루프의 프롬프트 프리셋·서브에이전트 기능을 제어한다. 프롬프트 UI는 `@keundal/ui-settings-llm/prompt-plugin`으로 분리하고 LLM 설정 UI와 독립적으로 선택한다. 이 UI와 `@keundal/ui-subagents`는 각각 해당 실행 기능에 의존한다.

`@keundal/ui-tool`은 `delegate_task`, `skill`, `web_search`, `google_search` 결과를, `@keundal/ui-chart`와 `@keundal/ui-weather`는 차트와 날씨 결과를 표시한다. 이 결과 UI도 각각 끄고 켤 수 있지만 실행 도구에는 의존하지 않는다. 도구를 끄면 이후 실행 목록에서 해당 도구만 제외하며, 사용자가 UI를 따로 끄지 않으면 기존 결과를 계속 표시한다.

실행 선택의 저장은 실행 방식의 관리자가 맡는다. web의 `BrowserRuntimePluginManager`는 기존 `keundal:bundled-plugins` localStorage를 사용하고 desktop은 기존 네이티브 저장소와 이전 선택 형식을 유지·이전한다. UI 선택은 브라우저 localStorage의 `keundal:ui-plugin-selections`에 별도로 저장한다. 이전 `keundal-ui-plugins` 쿠키는 읽거나 선택에 반영하지 않는다. 서버 렌더링과 최초 하이드레이션은 기본 UI를 등록하며, 앱이 마운트된 뒤 저장한 선택과 의존 상태를 동기화한다.

배포 설정을 덮어쓰는 관리 API는 제공하지 않는다. 선택 기능의 활성화 오류는 진단으로 표시하며, 관리 화면에 접근할 수 있도록 앱 시작은 유지한다. 원격 서버의 실행 기능은 해당 호스트에서 관리한다. `platform.runtimePlugins`가 없는 원격 연결에서도 로컬 UI 목록과 선택은 제공하지만 서버의 실행 기능이나 설치 상태는 바꾸지 않는다.

저장소와 `session`의 수명은 LLM에 종속시키지 않는다. LLM을 교체하면 `generation`과 에이전트만 다시 구성하고 기존 대화와 journal은 유지한다. 플러그인 전체를 해제할 때는 진행 중인 생성을 먼저 정리한 뒤 소유한 저장소를 닫는다.

## 검토한 선택

- 앱의 TypeScript 조립 코드만 두는 안: 구현을 바꿀 때마다 앱을 다시 빌드해야 하므로 사용하지 않는다.
- YAML 로더: 기존 JSON 형식과 별도 설정 형식을 유지할 이유가 없어 사용하지 않는다.
- 배포 매니페스트를 UI에서 직접 수정하는 안: 필수 서비스와 사용자의 선택 기능을 같은 수명으로 관리하게 되므로 사용하지 않는다.
- UI 선택을 쿠키에 저장하는 안: 브라우저 localStorage를 사용하며, 실행 기능과의 관계는 `requires`로 관리한다.
- web의 외부 모듈 설치: Node.js 패키지 설치와 로컬 경로 접근은 desktop에서만 제공한다.
- MCP 도구 조립만을 위한 별도 패키지: 독립 소비자가 없으므로 추가하지 않는다.

플랫폼별 구현 선택은 `docs/plugin-composition.md`에 정리한다.
