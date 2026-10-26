# @keundal/plugin-runtime

`RuntimePluginManifest`를 파싱하고 Cordis 플러그인과 도구 팩터리를 불러옵니다. 호출자는 모듈을 가져올 함수와 선택 가능한 기본 플러그인 목록을 전달합니다. 컨텍스트 생성과 해제도 호출자가 담당합니다.

```ts
import { loadRuntimePlugins, parseRuntimePluginManifest } from '@keundal/plugin-runtime'

const manifest = parseRuntimePluginManifest(JSON.parse(configText))
const runtime = await loadRuntimePlugins(manifest, {
  importModule: (specifier) => import(specifier),
  builtins
})
await runtime.setup(ownedContext)
const agentFiber = await runtime.mountAgent(ownedContext, {
  model: 'your-model',
  maxOutputTokens: 1024
})
```

`plugins`는 배열 순서대로 설치합니다. `builtin:`으로 시작하는 모듈 이름은 `builtins`에서만 찾습니다. 도구 팩터리는 도구를 열거할 때마다 실행 옵션과 함께 호출합니다. `manifest.tools: []`는 도구 팩터리가 없는 구성을 뜻합니다.

`mountRuntimePlugin(ctx, spec, options)`는 선택 기능 하나를 등록하고 활성화가 실패하면 해당 범위를 정리합니다. 반환된 Fiber의 `dispose()`로 효과를 해제하며, 번들 기능의 선택 저장과 활성 상태 관리는 플랫폼이 담당합니다.

기본 플러그인 목록의 키는 `builtin:store`처럼 전체 이름을 사용합니다. `runtime.tools(execution)`은 실제로 구성한 도구를 조회하므로 기능 목록에도 같은 구성을 사용할 수 있습니다. 매니페스트의 에이전트 설정과 실행 설정이 겹치면 실행 설정이 우선합니다. `agent.config.tools`는 허용하지 않습니다.

`deferredToolProvider`에는 검색으로 노출할 도구 공급자를 전달합니다. 매니페스트의 `agent.config.deferredTools`에 `{}` 또는 검색 한도를 지정하면 이 공급자를 에이전트의 Deferred Tools로 연결합니다. `manifest.tools`와 `options.tools`는 항상 노출하는 도구로 유지합니다.

`deferredTools`를 지정하지 않으면 두 공급자의 도구를 모두 직접 노출하므로 기존 호출을 유지합니다. `runtime.tools()`는 두 목록을 합친 허용 도구 목록을 반환합니다. 모델에 노출할 Schema는 에이전트의 실행별 검색 상태가 정합니다.

플랫폼별 설정 위치와 외부 모듈 형식은 [플러그인 조립 문서](../../docs/plugin-composition.md#런타임-설정)를 참고합니다.
