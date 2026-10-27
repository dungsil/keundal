# @keundal/plugin-subtitle-translate

`@keundal/media`의 `SubtitleTranslationService`를 `llm` 서비스로 구현합니다. 자막 트랙을 배치로 나눠 번역하고, 실패한 배치는 원문을 유지합니다.

## 설정

```ts
import subtitleTranslatePlugin from '@keundal/plugin-subtitle-translate'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(subtitleTranslatePlugin, {
  batchSize: 8,
  concurrency: 2,
  retries: 2,
  retryDelayMs: 500
})
```

이 플러그인은 `ctx.llm`을 주입받습니다. 공급자 선택과 API 키는 `@keundal/plugin-llm-*`가 맡습니다.

## 사용

```ts
const result = await ctx.subtitleTranslation.translate({
  track,
  targetLanguage: 'ko',
  model: 'gpt-4.1-mini',
  title: '첫 영상',
  batchSize: 8,
  concurrency: 2,
  context: 'window'
})
```

결과 트랙의 `id`는 `translation:<언어>`이고 `kind`는 `translation`입니다. 구간의 시작·끝 시각과 화자 정보는 원본 그대로 남습니다.

| 필드       | 뜻                                |
| ---------- | --------------------------------- |
| `failed`   | 번역에 실패해 원문을 남긴 구간 수 |
| `skipped`  | 빈 구간이라 요청에서 뺀 수        |
| `requests` | 실제로 보낸 요청 수, 재시도 포함  |

## 요청 구성

모델에는 시스템 지시문과 JSON 본문을 보냅니다. 본문에는 대상 언어, 영상 제목, 사용자 지시문, 앞선 세 구간, 줄 배열이 들어 있습니다. 응답은 같은 개수와 같은 순서의 문자열 배열이어야 합니다.

`context`가 `full`이면 전체 자막을 함께 보냅니다. 용어와 고유명사를 일관되게 유지하는 대신 토큰을 더 씁니다.

## 실패 처리

응답이 배열이 아니거나 항목 수가 다르면 그 배치는 실패로 기록하고 원문을 남깁니다. `429`와 `5xx`, 시간 초과 문구가 있는 오류는 `retries`만큼 다시 보냅니다. 재시도 간격은 시도마다 늘어납니다.

## 한계

번역은 요청 단위로만 취소됩니다. 이미 보낸 요청의 결과는 버리지만 공급자 쪽 과금은 남습니다.

응답 검증은 개수와 순서만 봅니다. 번역 품질이나 언어 일치는 검사하지 않습니다.
