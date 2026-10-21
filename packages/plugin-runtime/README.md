# @keundal/plugin-runtime

`RuntimePluginManifest`를 파싱하고 Cordis 플러그인과 도구 팩터리를 불러옵니다. 이 패키지는 모듈을 가져올 함수와 선택 가능한 기본 플러그인 목록을 호출자가 전달받습니다. 컨텍스트 생성과 해제도 호출자가 담당합니다.

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
