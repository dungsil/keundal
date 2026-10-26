# @keundal/plugin-tool-chart

`createChartTools()`는 선 그래프를 만드는 `chart` 도구만 `ExecutableTool[]`로 반환합니다. 기본 내보내기도 같은 팩터리이므로 런타임 매니페스트의 `tools`에서 패키지 이름으로 선택할 수 있습니다.

```ts
import { createChartTools } from '@keundal/plugin-tool-chart'

const tools = createChartTools()
```

입력 검증과 JSON 결과 형식은 기존과 같습니다. 스키마는 `@keundal/chat/tools/chart`, 결과 카드는 `@keundal/ui-chart`가 제공합니다. 앱의 조립부가 날씨 도구와 별도로 선택합니다.
