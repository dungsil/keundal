# @keundal/plugin-llm-browser

브라우저 설정을 읽어 주입받은 LLM을 호출하고 모델 목록을 캐시합니다. 구체적인 공급자 패키지에는 의존하지 않습니다.

`browserLLMPlugin(ctx, { getSettings, getModels, providers })`의 `providers`는 공급자별 Cordis 플러그인 로더입니다. `./models`의 `loadModels(modelLoaders, provider, settings, storage, options)`도 공급자별 모델 목록 로더를 받습니다.

기본 OpenAI·Anthropic·Gemini 구성이 필요하면 앱에서 `@keundal/browser-composition/llm`의 `browserLLMPlugin`과 `loadModels`를 사용합니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
