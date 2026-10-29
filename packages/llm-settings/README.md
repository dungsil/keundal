# @keundal/llm-settings

LLM 공급자 설정의 스키마, 기본값, 공급자 목록과 자격 증명 검증을 제공합니다. 설정 저장이나 공급자 SDK 실행은 담당하지 않습니다.

```ts
import { defaultLLMSettings, registeredProviders } from '@keundal/llm-settings'

const settings = defaultLLMSettings()
const providers = registeredProviders(settings)
```

`providerError()`는 화면에 전달할 진단에서 자격 증명을 제거합니다. 브라우저 저장소와 네이티브 보안 저장소는 같은 설정 타입을 사용하고, 각 앱이 저장소 구현을 선택합니다.

공급자 설정의 `modelsDev`는 모델 목록에 채울 models.dev 메타데이터를 지정합니다. 공식 API는 자동 연결하므로 생략할 수 있습니다. 호환 API는 models.dev의 공급자 ID를 명시하고, 모델 ID가 다르면 `models`에 요청 ID → models.dev ID를 지정합니다. 아래는 설정 객체의 예시이며, 별도 편집 UI는 제공하지 않습니다.

```ts
settings['openai-chat@gateway'] = {
  name: 'Gateway',
  apiKey: '',
  baseURL: 'https://gateway.example/v1',
  models: ['my-model'],
  modelsDev: {
    provider: 'openrouter',
    models: { 'my-model': 'anthropic/claude-haiku-4.5' }
  }
}
```

매핑이나 직접 추가한 모델 목록을 바꾸면 모델 캐시도 갱신합니다. 연결 동작과 가격 단위는 [브라우저 모델 연결 문서](../plugin-llm-browser/README.md)를 참고합니다.
