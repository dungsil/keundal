# @keundal/ui-composer

프롬프트 입력창을 `composer` 팩터리로 등록하는 UI 플러그인입니다. 홈과 대화 페이지가 `<SlotFactory name="composer">`로 같은 입력창을 그리며, 페이지는 `ComposerOwner`로 입력값, 파일, 상태, 전송 콜백을 넘깁니다.

입력창, 파일 미리보기, `+` 메뉴(파일 추가와 웹 검색), `/` 스킬·MCP 도구 목록, 실행 중 전달 방식 선택, 전송·중지·재생성 버튼을 그립니다. 도구 목록은 `runtime.promptCatalog`, 웹 검색은 `runtime.webSearch`와 `runtime.model`을 사용합니다.

팩터리 안에 슬롯 두 개를 선언합니다.

- `composer.actions` (`list`, 소유자 `{ disabled }`): 메뉴 버튼과 전송 버튼 사이의 컨트롤입니다. 모델·추론 수준 선택이 `order` 순서로 들어갑니다.
- `composer.dictation` (`single`, 소유자 `ComposerDictationOwner`): 프롬프트가 비어 있을 때 전송 버튼 대신 그립니다. 등록된 항목이 없으면 전송 버튼이 그대로 보입니다.
