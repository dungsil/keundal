# @keundal/plugin-llm-openai

공식 OpenAI SDK의 Responses API로 `@keundal/core`의 `LLMService`를 구현합니다. Cordis 플러그인으로 등록하면 `ctx.llm`에서 모델 한도 조회, 입력 토큰 계산, AG-UI 이벤트 스트리밍을 사용할 수 있습니다.

## 설정

| 설정      | 설명                                                                               |
| --------- | ---------------------------------------------------------------------------------- |
| `apiKey`  | OpenAI API 키입니다. 생략하면 SDK가 `OPENAI_API_KEY`를 사용합니다.                 |
| `baseURL` | API 기본 주소입니다. 생략하면 SDK의 기본 설정을 사용합니다.                        |
| `models`  | 모델 ID를 키로 사용하며, 각 값에 `contextWindow`와 `maxOutputTokens`를 지정합니다. |

모델 한도는 [사용할 모델의 공식 문서](https://developers.openai.com/api/docs/models)에서 확인해 설정합니다. OpenAI의 모델 조회 API는 컨텍스트·출력 한도를 반환하지 않으므로 `getModel()`은 이 설정을 조회합니다. 등록하지 않은 모델이나 한도를 초과하는 출력 예산은 요청 전에 거부합니다.

`countTokens()`는 [Responses 입력 토큰 계산 API](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens/methods/count)를 호출합니다. 메시지, 부가 문맥, 도구 정의를 생성 요청과 동일하게 변환하며, 로컬 추정값으로 대체하지 않습니다.

## 직접 호출

워크스페이스에서 `pnpm build`를 실행한 뒤 사용할 수 있습니다. 아래 코드의 `OPENAI_MODEL`, `OPENAI_CONTEXT_WINDOW`, `OPENAI_MAX_OUTPUT_TOKENS`는 호출하는 애플리케이션에서 플러그인 설정을 만드는 예시 환경 변수입니다. `OPENAI_API_KEY`도 설정해야 합니다.

```ts
import type { LLMRequest } from '@keundal/core'
import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import { Context } from 'cordis'

const model = process.env.OPENAI_MODEL
if (!model) throw new Error('OPENAI_MODEL is required')
const contextWindow = Number(process.env.OPENAI_CONTEXT_WINDOW)
const maxOutputTokens = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS)

const ctx = new Context()
const fiber = await ctx.plugin(openaiLLMPlugin, {
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

`countTokens()`와 `stream()`의 두 번째 인자에 `{ signal }`을 전달할 수 있습니다. 취소 신호, 순회 중단, 플러그인 해제는 진행 중인 요청을 취소합니다. HTTP·전송 오류는 SDK 오류를 유지하고, 공급자가 명시한 `error`·`response.failed`·`response.incomplete`는 예외로 전달합니다. 자동 재시도는 하지 않습니다.

오류 없이 EOF에 도달하면 `response.completed`가 없어도 정상 종료합니다. 아직 열린 텍스트·추론 메시지는 종료 이벤트를 보완하고 받은 내용을 유지합니다. 완료되지 않은 도구 호출은 예외로 전달하며, 수신하지 않은 내용이나 미확정 암호화 값을 보충하지 않습니다. `generation`과 함께 사용하면 받은 내용을 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 실행이 다른 프로세스나 탭에 회수되어 종료가 확정된 경우에는 커밋 없이 `RUN_FINISHED` 없이 끝날 수 있습니다.

## 입력과 이벤트

- 시스템·개발자·사용자·어시스턴트 메시지, 함수 호출과 결과, 추론 메시지를 변환합니다. 사용자 입력은 텍스트와 이미지 URL·base64·파일 ID를 지원합니다. 문서·음성·동영상 입력과 `activity` 메시지는 오류로 알립니다.
- `input.context`는 사용자 역할의 JSON 메시지로 전달합니다. `state`와 `forwardedProps`는 공급자 요청에 자동으로 포함하지 않습니다.
- 텍스트, 거절 응답, 함수 호출 인자, 추론 요약을 AG-UI 이벤트로 전달합니다. 함수 호출은 요청 이벤트까지 전달하며 도구를 실행하지 않습니다.
- 추론 항목의 최종 암호화 값은 `REASONING_ENCRYPTED_VALUE`로 전달합니다. 후속 요청을 구성하는 쪽에서 해당 `reasoning` 메시지의 `id`, `content`, `encryptedValue`를 보존해야 합니다.
- 어시스턴트 메시지의 `phase`는 시작·종료 이벤트의 `metadata['openai.phase']`로 전달합니다. 저장된 메시지에도 이 메타데이터를 유지하면 후속 요청에서 복원합니다.

요청에는 `store: false`와 `truncation: 'disabled'`를 지정합니다. 대화와 문맥 축약은 Keundal 측에서 관리합니다. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`는 생성하지 않으며, journal·커밋·복구도 수행하지 않습니다. 전체 에이전트를 실행하려면 저장소 플러그인과 `@keundal/plugin-agent-simple`을 함께 등록합니다.
