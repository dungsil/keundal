# @keundal/ui-home

새 대화를 시작하는 첫 화면을 `page.home` 슬롯에 등록하는 UI 플러그인입니다. 입력창과 추천 질문 버튼을 그립니다. 입력창은 `<SlotFactory name="composer">`로 `ui-composer`의 팩터리를 사용하고, 파일 업로드와 끌어다 놓기는 이 화면이 맡습니다.

메시지를 보내면 `runtime.store.create`로 대화를 만들고 `runtime.refreshChats()`로 목록을 갱신한 뒤 `/chat/<id>`로 이동합니다. 화면을 열 때 `runtime.applyDefaultModel()`로 저장된 기본 모델을 적용합니다.

첫 화면은 인사말 없이 입력창과 추천 질문 버튼을 한 묶음으로 배치합니다. 화면 제목은 스크린 리더에만 제공하며, 시간대별 인사말 스크립트는 사용하지 않습니다.
