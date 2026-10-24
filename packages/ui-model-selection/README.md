# @keundal/ui-model-selection

모델과 추론 수준 선택을 제공하는 UI 플러그인입니다.

`composer.actions` 슬롯에 모델 선택(`order` 10)과 추론 수준 선택(`order` 20)을 등록합니다. 모델 목록을 열 때 캐시된 목록을 갱신하고, 선택한 모델로 전환하는 동안에는 선택을 막습니다. 추론 수준 선택은 현재 모델이 지원하는 수준이 있을 때만 보입니다.

`settings.section` 슬롯에 `models` 섹션(`order` 20, `general`)을 등록합니다. 채팅 모델과 제목 생성 모델의 기본값을 이 기기에 저장합니다.

데이터는 `runtime`의 `selectedModel`, `models`, `modelsLoading`, `modelsError`, `refreshModels`, `defaultModel`, `titleModel`, `saveDefaultModel`, `saveTitleModel`, `switching`, `reasoning`, `reasoningLevels`를 사용합니다.
