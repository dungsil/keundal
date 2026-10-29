# @keundal/plugin-llm-browser

브라우저 설정을 읽어 주입받은 LLM을 호출하고 모델 목록을 캐시합니다. 구체적인 공급자 패키지에는 의존하지 않습니다.

`browserLLMPlugin(ctx, { getSettings, getModels, providers })`의 `providers`는 공급자별 Cordis 플러그인 로더입니다. `./models`의 `loadModels(modelLoaders, provider, settings, storage, options)`도 공급자별 모델 목록 로더를 받습니다.

기본 OpenAI·Anthropic·Gemini 구성이 필요하면 앱에서 `@keundal/browser-composition/llm`의 `browserLLMPlugin`과 `loadModels`를 사용합니다.

모델 목록을 불러올 때 공식 API 주소는 `https://models.dev/api.json`의 공급자·모델 ID와 일치하는 메타데이터를 채웁니다. OpenAI Responses와 Chat Completions는 `openai`, Anthropic은 `anthropic`, Gemini는 `google`에 연결합니다. API에서 반환한 이름과 한도를 우선하며, 없는 값만 보완합니다. 모델의 생성 지원 기능은 models.dev에서 추정하지 않습니다.

- `contextWindow`, `maxInputTokens`, `maxOutputTokens`는 각각 `limit.context`, `limit.input`, `limit.output`입니다. 입력 한도가 없으면 context 한도로 대신 채우지 않습니다.
- `cost.input`, `cost.output`, `cost.cacheRead`, `cost.cacheWrite`는 각각 `cost.input`, `cost.output`, `cost.cache_read`, `cost.cache_write`이며 단위는 100만 토큰당 USD입니다. 0은 무료이고, 누락·잘못된 값은 미상입니다. 구간별·모달리티별·서비스 등급별 가격은 포함하지 않습니다.
- 메타데이터는 기존 모델 캐시에 함께 보관합니다. 강제 갱신 시 다시 조회하며, models.dev 오류·5초 제한 시간 초과 시 공급자가 반환한 모델 목록을 유지합니다. 공급자 인증 정보와 사용자 API 주소는 models.dev로 보내지 않습니다.
- 이 가격은 모델 목록의 메타데이터입니다. 에이전트의 `pricing` 설정이나 실행 추적의 비용을 자동으로 변경하지 않습니다. 기존 브라우저 실행의 입력·출력 예산 상한도 유지합니다.

호환 API는 프로토콜만으로 공급자를 추정하지 않습니다. 공급자 설정의 `modelsDev`로 models.dev 공급자와 모델 별칭을 지정할 수 있습니다. 원래 요청 모델 ID는 바꾸지 않습니다. `models`에 직접 추가한 모델에도 같은 매핑을 적용합니다. 설정 예시는 [LLM 설정 문서](../llm-settings/README.md)를 참고합니다.

[플러그인 조립과 의존성 경계](../../docs/plugin-composition.md)를 참고합니다.
