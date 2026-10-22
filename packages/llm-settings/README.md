# @keundal/llm-settings

LLM 공급자 설정의 스키마, 기본값, 공급자 목록과 자격 증명 검증을 제공합니다. 설정 저장이나 공급자 SDK 실행은 담당하지 않습니다.

```ts
import { defaultLLMSettings, registeredProviders } from '@keundal/llm-settings'

const settings = defaultLLMSettings()
const providers = registeredProviders(settings)
```

`providerError()`는 화면에 전달할 진단에서 자격 증명을 제거합니다. 브라우저 저장소와 네이티브 보안 저장소는 같은 설정 타입을 사용하고, 각 앱이 저장소 구현을 선택합니다.
