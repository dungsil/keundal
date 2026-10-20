# @keundal/plugin-llm-openai

공식 OpenAI SDK의 Responses API로 `@keundal/core`의 `LLMService`를 구현합니다. Cordis 플러그인으로 등록하면 `ctx.llm`에서 모델 한도 조회, 입력 토큰 계산, AG-UI 이벤트 스트리밍을 사용할 수 있습니다.

## 설정

| 설정      | 설명                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `apiKey`  | OpenAI API 키입니다. 생략하면 SDK가 `OPENAI_API_KEY`를 사용합니다.                                    |
| `baseURL` | API 기본 주소입니다. 생략하면 SDK의 기본 설정을 사용합니다.                                           |
| `headers` | 선택적인 HTTP 헤더 문자열 맵입니다. SDK의 `defaultHeaders`로 전달하며 기본 헤더를 덮어쓸 수 있습니다. |
| `models`  | 모델 ID를 키로 사용하며, 각 값에 `contextWindow`와 `maxOutputTokens`를 지정합니다.                    |

모델 한도는 [사용할 모델의 공식 문서](https://developers.openai.com/api/docs/models)에서 확인해 설정합니다. OpenAI의 모델 조회 API는 컨텍스트·출력 한도를 반환하지 않으므로 `getModel()`은 이 설정을 조회합니다. 등록하지 않은 모델이나 한도를 초과하는 출력 예산은 요청 전에 거부합니다.

`countTokens()`는 메시지, 부가 문맥, 도구 정의를 생성 요청과 동일하게 변환해 [Responses 입력 토큰 계산 API](https://developers.openai.com/api/reference/typescript/resources/responses/subresources/input_tokens/methods/count)를 먼저 호출합니다. 이 API 호출이 실패하면 호환 모드로 전환해 생성 입력 JSON의 UTF-8 바이트 수를 로컬 추정값으로 사용합니다. 같은 서비스 인스턴스에서는 이후 토큰 계산 API를 다시 호출하지 않으며, 인스턴스를 새로 만들면 다시 확인합니다. 404뿐 아니라 HTTP·전송 오류도 이 전환 대상입니다.

호환 모드에서도 입력 예산 검사와 축약은 유지하지만 실제 토큰 수를 보장하지 않습니다. 텍스트에는 보수적인 추정이며 이미지·파일 ID·추론 암호문 등은 실제 토큰 비용과 크게 다를 수 있습니다. 취소·플러그인 해제, 로컬 입력·예산 검증 오류, 성공 응답의 잘못된 토큰 수는 대체하지 않고 거부합니다. 생성은 계속 Responses API를 사용하며 Chat Completions로 바꾸지 않습니다. 생성 요청 자체의 오류도 그대로 전달합니다.

브라우저에서 실행하려면 `apiKey`와 `dangerouslyAllowBrowser: true`를 명시합니다. 생략하면 SDK의 브라우저 실행 차단을 유지합니다. 브라우저 키는 사용자·스크립트·확장 기능에 노출될 수 있으므로 서버 소유 비밀 키를 번들에 넣지 마세요. 사용자 자신의 키를 사용하는 앱에서만 위험을 안내하고 opt-in하며, 엔드포인트의 CORS 지원도 필요합니다.

## 모델 목록 조회

`listOpenAIModels({ apiKey, baseURL?, headers? }, { signal? })`은 `/models`에서 모델 목록을 조회합니다. 플러그인 등록과 `models` 설정은 필요하지 않습니다. `apiKey`는 직접 전달하며, 빈 문자열이면 기본 인증 헤더를 보내지 않습니다. 커스텀 인증 헤더는 그대로 적용합니다.

결과는 `@keundal/core`의 `LLMModelInfo[]`이며 공급자 접두사 없는 `id`, 표시 이름 `name`, 선택적인 `contextWindow`·`maxOutputTokens`를 포함합니다. 호환 API가 반환한 한도는 보존하지만, 한도가 없는 모델에 기본값을 넣지 않습니다. Responses API 지원 여부는 모델마다 따로 확인해야 합니다.

조회는 자동 재시도하거나 캐시하지 않습니다. 호출자가 취소 신호와 시간제한을 지정합니다. HTTP 오류는 `status`와 HTTP 400의 JSON 본문인 `error`를 전달합니다. UI에 표시하기 전에 호출자가 비밀 값을 제거해야 합니다.

`apiKey: ''`를 명시하면 인증이 필요 없는 호환 엔드포인트에 요청할 수 있습니다. 모델 조회·토큰 계산·생성 요청에서 기본 인증 헤더를 생략하고 환경 변수의 키도 사용하지 않습니다. `headers`로 지정한 인증 헤더는 그대로 적용합니다. `apiKey`를 생략하면 기존 SDK의 환경 변수 처리를 유지합니다.

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

`countTokens()`와 `stream()`의 두 번째 인자에 `{ signal }`을 전달할 수 있습니다. 취소 신호, 순회 중단, 플러그인 해제는 진행 중인 요청을 취소합니다. 생성 요청의 HTTP·전송 오류는 SDK 오류를 유지하고, 공급자가 명시한 `error`·`response.failed`·`response.incomplete`는 예외로 전달합니다. 자동 재시도는 하지 않습니다.

오류 없이 EOF에 도달하면 `response.completed`가 없어도 정상 종료합니다. 아직 열린 텍스트·추론 메시지는 종료 이벤트를 보완하고 받은 내용을 유지합니다. 완료되지 않은 도구 호출은 예외로 전달하며, 수신하지 않은 내용이나 미확정 암호화 값을 보충하지 않습니다. `generation`과 함께 사용하면 받은 내용을 커밋한 뒤 `RUN_FINISHED`를 전달합니다. 실행이 다른 프로세스나 탭에 회수되어 종료가 확정된 경우에는 커밋 없이 `RUN_FINISHED` 없이 끝날 수 있습니다.

## 입력과 이벤트

- `LLMRequest.webSearch: true`는 함수 도구와 함께 네이티브 `{ type: 'web_search' }` 도구를 등록합니다. false/생략은 등록하지 않습니다. 검색 호출은 로컬 실행용 `TOOL_CALL_*`로 내보내지 않습니다.
- `reasoning: true`는 `{ effort: 'medium', summary: 'auto' }`를 전송합니다. false는 GPT-5/mini/nano(날짜 snapshot 포함)에 `minimal`(검색 시 `low`), 그 외 모델에는 `none`을 전송하고 요약을 요청하지 않습니다. 초기 GPT-5 계열은 추론을 완전히 끌 수 없습니다. 생략하면 공급자 기본값을 유지합니다. 추론 토큰도 기존 `max_output_tokens` 예산 안에서 사용하며, 모델이 해당 옵션과 검색을 지원해야 합니다. 지원하지 않는 모델의 API 오류는 그대로 전달합니다. 토큰 계산에도 같은 도구·추론 설정을 사용합니다.
- URL 인용은 `{ type: 'CUSTOM', name: 'keundal.source', value: { id, url, title? } }`로 전달하며 `id`는 URL입니다. 같은 URL이 여러 번 인용되면 이벤트도 반복될 수 있습니다.
- 네이티브 문맥은 `TEXT_MESSAGE_END.metadata['openai.outputItems']`에 **SDK의 완료된 출력 항목 배열**로 보존합니다. 각 검색 전용 어시스턴트 호스트에는 `[ResponseFunctionWebSearch]`(원래 `id`, `status`, `action` 포함), 인용 텍스트 호스트에는 `[ResponseOutputMessage]`(원래 `phase`, `content[].annotations` 포함)를 담습니다. 후속 변환은 이 배열을 텍스트 대신 재생하고 로컬 함수 호출을 뒤에 추가합니다. 메시지 순서와 메타데이터를 수정하지 말고 보존해야 검색·텍스트·추론·함수 호출 순서가 유지됩니다. 추론 암호화 값은 기존 `reasoning.encryptedValue`에 따로 유지합니다.
- 시스템·개발자·사용자·어시스턴트 메시지, 함수 호출과 결과, 추론 메시지를 변환합니다. 사용자 입력은 텍스트와 이미지 URL·base64·파일 ID를 지원합니다. 문서·음성·동영상 입력과 `activity` 메시지는 오류로 알립니다.
- `input.context`는 사용자 역할의 JSON 메시지로 전달합니다. `state`와 `forwardedProps`는 공급자 요청에 자동으로 포함하지 않습니다.
- 텍스트, 거절 응답, 함수 호출 인자, 추론 요약을 AG-UI 이벤트로 전달합니다. 함수 호출은 요청 이벤트까지 전달하며 도구를 실행하지 않습니다.
- 추론 항목의 최종 암호화 값은 `REASONING_ENCRYPTED_VALUE`로 전달합니다. 후속 요청을 구성하는 쪽에서 해당 `reasoning` 메시지의 `id`, `content`, `encryptedValue`를 보존해야 합니다.
- 어시스턴트 메시지의 `phase`는 시작·종료 이벤트의 `metadata['openai.phase']`로 전달합니다. 저장된 메시지에도 이 메타데이터를 유지하면 후속 요청에서 복원합니다.

요청에는 `store: false`와 `truncation: 'disabled'`를 지정합니다. 대화와 문맥 축약은 Keundal 측에서 관리합니다. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`는 생성하지 않으며, journal·커밋·복구도 수행하지 않습니다. 전체 에이전트를 실행하려면 저장소 플러그인과 `@keundal/agent`을 함께 등록합니다.
