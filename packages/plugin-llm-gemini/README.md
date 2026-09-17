# @keundal/plugin-llm-gemini

공식 `@google/genai` SDK의 Gemini API로 `@keundal/core`의 `LLMService`를 구현합니다. Cordis 플러그인으로 등록하면 `ctx.llm`에서 모델 한도 조회, 입력 토큰 계산, AG-UI 이벤트 스트리밍을 사용할 수 있습니다.

## 설정

| 설정      | 설명                                                                                                     |
| --------- | -------------------------------------------------------------------------------------------------------- |
| `apiKey`  | Gemini API 키입니다. 생략하면 SDK가 `GEMINI_API_KEY`나 `GOOGLE_API_KEY`를 사용합니다.                    |
| `baseURL` | API 기본 주소입니다. 생략하면 SDK의 기본 설정(`https://generativelanguage.googleapis.com`)을 사용합니다. |
| `models`  | 모델 ID를 키로 사용하며, 각 값에 `contextWindow`와 `maxOutputTokens`를 지정합니다.                       |

모델 한도는 [사용할 모델의 공식 문서](https://ai.google.dev/gemini-api/docs/models)에서 확인해 설정합니다. 등록하지 않은 모델이나 한도를 초과하는 출력 예산은 요청 전에 거부합니다.

`countTokens()`는 Gemini API의 토큰 계산 엔드포인트를 호출합니다. 이 엔드포인트는 `contents`만 받으므로 시스템·개발자 지시문은 사용자 차례로 접어 계산에 포함하고, 도구 선언은 계산에 포함되지 않습니다. 대화와 부가 문맥은 생성 요청과 동일한 변환을 사용합니다.

## 직접 호출

워크스페이스에서 `pnpm build`를 실행한 뒤 사용할 수 있습니다. 아래 코드의 `GEMINI_MODEL`, `GEMINI_CONTEXT_WINDOW`, `GEMINI_MAX_OUTPUT_TOKENS`는 호출하는 애플리케이션에서 플러그인 설정을 만드는 예시 환경 변수입니다. `GEMINI_API_KEY`도 설정해야 합니다.

```ts
import type { LLMRequest } from '@keundal/core'
import geminiLLMPlugin from '@keundal/plugin-llm-gemini'
import { Context } from 'cordis'

const model = process.env.GEMINI_MODEL
if (!model) throw new Error('GEMINI_MODEL is required')
const contextWindow = Number(process.env.GEMINI_CONTEXT_WINDOW)
const maxOutputTokens = Number(process.env.GEMINI_MAX_OUTPUT_TOKENS)

const ctx = new Context()
const fiber = await ctx.plugin(geminiLLMPlugin, {
  models: { [model]: { contextWindow, maxOutputTokens } }
})

try {
  const request: LLMRequest = {
    model,
    maxOutputTokens: Math.min(1024, maxOutputTokens, contextWindow - 1),
    input: {
      threadId: 'conversation-1',
      runId: 'run-1',
      state: {},
      messages: [{ id: 'user-1', role: 'user', content: '안녕하세요.' }],
      tools: [],
      context: []
    }
  }

  console.log('input tokens:', await ctx.llm.countTokens(request))
  for await (const event of ctx.llm.stream(request)) console.log(event)
} finally {
  await fiber.dispose()
}
```

`countTokens()`와 `stream()`의 두 번째 인자에 `{ signal }`을 전달할 수 있습니다. 취소 신호, 순회 중단, 플러그인 해제는 진행 중인 요청을 취소합니다. HTTP 오류는 SDK 오류(`status` 포함)를 유지하고, 스트림 단절과 `STOP`이 아닌 종료 사유는 예외로 전달합니다. 자동 재시도는 하지 않습니다.

## 입력과 이벤트

- 시스템·개발자 메시지는 `systemInstruction`으로, 사용자와 모델 차례는 `contents`로 변환합니다. 사용자 입력은 텍스트와 이미지를 지원하며, 이미지는 URL과 파일 식별자를 `fileData`로, base64 데이터를 `inlineData`로 전달합니다. 문서·음성·동영상 입력과 `activity` 메시지는 오류로 알립니다.
- `input.context`는 사용자 차례의 JSON 메시지로 전달합니다. `state`와 `forwardedProps`는 공급자 요청에 자동으로 포함하지 않습니다.
- 어시스턴트 메시지는 텍스트와 함수 호출 파트로 변환합니다. 함수 호출 인자는 JSON 객체여야 하고, 도구 결과는 함수 이름과 짝이 맞아야 합니다. 도구 결과가 JSON 객체가 아니면 `output` 키로 감싸 전달합니다.
- `thinkingConfig.includeThoughts`를 켜서 추론 요약을 받아 `REASONING_*` 이벤트로 전달합니다. 함수 호출은 `TOOL_CALL_*` 이벤트로 전달하며 도구를 실행하지 않습니다. Gemini API는 호출 식별자를 주지 않으므로 응답 식별자와 순번으로 ID를 만들고, 공급자가 식별자를 주면 그것을 사용합니다.
- thought 서명은 `REASONING_ENCRYPTED_VALUE`로 전달합니다. 추론 파트의 서명은 `subtype: 'message'`이고 함수 호출 파트의 서명은 `subtype: 'tool-call'`입니다. 후속 요청을 구성하는 쪽에서 추론 메시지의 `content`·`encryptedValue`와 도구 호출의 `encryptedValue`를 보존하면 각 파트의 `thoughtSignature`로 복원됩니다. 텍스트 파트에 실린 thought 서명은 Gemini가 후속 요청에서 요구하지 않으므로 전달하지 않습니다.
- `STOP`이 아닌 종료 사유(`MAX_TOKENS`, `SAFETY` 등)는 불완전 응답으로 예외로 전달합니다. 종료 사유 없이 스트림이 끝나거나 청크 순서가 어긋나도 예외로 전달합니다.

생성 요청에는 출력 예산을 `maxOutputTokens`로 지정합니다. 대화와 문맥 압축은 Keundal 측에서 관리합니다. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`는 생성하지 않으며, journal·커밋·복구도 수행하지 않습니다. 전체 에이전트를 실행하려면 `generation`, `session`, `compaction` 구현을 함께 등록해야 합니다.

## 검증

`pnpm test --filter=@keundal/plugin-llm-gemini`는 실제 `@google/genai` SDK와 로컬 HTTP 서버를 사용합니다. 요청 본문, 토큰 계산, SSE 변환, thought 서명 보존, 오류, 취소와 플러그인 해제를 검증하며, 실제 Google 계정의 인증·모델 접근 권한은 검증하지 않습니다.
