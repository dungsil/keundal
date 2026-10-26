# @keundal/plugin-tool-weather

`createWeatherTools()`는 5일 예보를 포함한 `weather` 도구만 `ExecutableTool[]`로 반환합니다. 기본 내보내기도 같은 팩터리이므로 런타임 매니페스트의 `tools`에서 패키지 이름으로 선택할 수 있습니다.

```ts
import { createWeatherTools } from '@keundal/plugin-tool-weather'

const tools = createWeatherTools()
```

날씨는 기존과 같이 무작위 데모 데이터이며 실제 기상 API를 호출하지 않습니다. 입력 검증과 JSON 결과 형식은 유지합니다. 스키마는 `@keundal/chat/tools/weather`, 결과 카드는 `@keundal/ui-weather`가 제공합니다. 앱의 조립부가 차트 도구와 별도로 선택합니다.
