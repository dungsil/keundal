# @keundal/ui-dictation

프롬프트가 비어 있을 때 전송 버튼 대신 마이크 버튼을 보여 주는 UI 플러그인입니다. `composer.dictation` 슬롯에 등록하며, 이 플러그인이 없으면 `ui-composer`는 전송 버튼만 그립니다.

web과 desktop의 기본 구성에는 포함하지 않습니다. 사용하려면 앱의 의존성과 Nuxt `extends`에 이 패키지를 추가하고 `app/ui-plugins.ts`에서 Cordis 플러그인을 등록합니다.

마이크 입력을 `runtime.platform.transcription`으로 스트리밍하고, 받아쓴 내용을 입력창 자리표시자에 보여 준 뒤 끝나면 프롬프트에 덧붙입니다. 전사 설정은 `runtime.settings`, 제공자 자격 확인은 `runtime.ensureConfigured`를 사용합니다. 녹음은 120초 뒤 자동으로 끝납니다.

`app/lib/use-dictation.ts`가 녹음 세션을, `app/lib/audio.ts`가 샘플링 비율 변환을 맡습니다.
