# @keundal/plugin-llm-anthropic

공식 `@anthropic-ai/sdk`의 Messages API로 `@keundal/core`의 `LLMService`를 구현합니다. Cordis 플러그인으로 등록하면 `ctx.llm`에서 모델 한도 조회, 입력 토큰 계산, AG-UI 이벤트 스트리밍을 사용할 수 있습니다.

## 설정

| 설정      | 설명                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------- |
| `apiKey`  | Anthropic API 키입니다. 생략하면 SDK가 `ANTHROPIC_API_KEY`를 사용합니다.                              |
| `baseURL` | API 기본 주소입니다. 생략하면 SDK의 기본 설정을 사용합니다.                                           |
| `headers` | 선택적인 HTTP 헤더 문자열 맵입니다. SDK의 `defaultHeaders`로 전달하며 기본 헤더를 덮어쓸 수 있습니다. |
| `models`  | 모델 ID를 키로 사용하며, 각 값에 `contextWindow`와 `maxOutputTokens`를 지정합니다.                    |

모델 한도는 [사용할 모델의 공식 문서](https://platform.claude.com/docs/en/about-claude/models/overview)에서 확인해 설정합니다. `getModel()`은 이 설정을 조회하며, 등록하지 않은 모델이나 한도를 초과하는 출력 예산은 요청 전에 거부합니다.

`countTokens()`는 [입력 토큰 계산 API](https://platform.claude.com/docs/en/api/messages/count_tokens)를 호출합니다. 메시지, 시스템·개발자 지시문, 부가 문맥, 도구 정의를 생성 요청과 동일하게 변환해 전달합니다.

브라우저에서 실행하려면 `apiKey`와 `dangerouslyAllowBrowser: true`를 명시합니다. 생략하면 SDK의 브라우저 실행 차단을 유지합니다. SDK의 브라우저 접근 헤더도 함께 전송됩니다. 브라우저 키는 사용자·스크립트·확장 기능에 노출될 수 있으므로 서버 소유 비밀 키를 번들에 넣지 마세요. 사용자 자신의 키를 사용하는 앱에서만 위험을 안내하고 opt-in하며, 엔드포인트의 CORS 지원도 필요합니다.

## 모델 목록 조회

`listAnthropicModels({ apiKey, baseURL?, headers?, dangerouslyAllowBrowser? }, { signal? })`은 `/v1/models`의 모든 페이지를 조회합니다. 플러그인 등록과 `models` 설정은 필요하지 않습니다. `apiKey`는 직접 전달합니다. `dangerouslyAllowBrowser: true`는 브라우저 접근 헤더를 추가합니다.

결과는 `@keundal/core`의 `LLMModelInfo[]`이며 공급자 접두사 없는 `id`, 표시 이름 `name`, 선택적인 `contextWindow`·`maxOutputTokens`를 포함합니다. 공급자가 반환한 한도만 보존하며 생성 설정을 변경하지 않습니다. 누락되거나 반복된 페이지 커서는 오류로 전달합니다.

조회는 자동 재시도하거나 캐시하지 않습니다. 호출자가 취소 신호와 시간제한을 지정합니다. HTTP 오류는 `status`와 HTTP 400의 JSON 본문인 `error`를 전달합니다. UI에 표시하기 전에 호출자가 비밀 값을 제거해야 합니다.

## 직접 호출

워크스페이스에서 `pnpm build`를 실행한 뒤 사용할 수 있습니다. 아래 코드의 `ANTHROPIC_MODEL`, `ANTHROPIC_CONTEXT_WINDOW`, `ANTHROPIC_MAX_OUTPUT_TOKENS`는 호출하는 애플리케이션에서 플러그인 설정을 만드는 예시 환경 변수입니다. `ANTHROPIC_API_KEY`도 설정해야 합니다.

```ts
import type { LLMRequest } from '@keundal/core'
import anthropicLLMPlugin from '@keundal/plugin-llm-anthropic'
import { Context } from 'cordis'

const model = process.env.ANTHROPIC_MODEL
if (!model) throw new Error('ANTHROPIC_MODEL is required')
const contextWindow = Number(process.env.ANTHROPIC_CONTEXT_WINDOW)
const maxOutputTokens = Number(process.env.ANTHROPIC_MAX_OUTPUT_TOKENS)

const ctx = new Context()
const fiber = await ctx.plugin(anthropicLLMPlugin, {
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

`countTokens()`와 `stream()`의 두 번째 인자에 `{ signal }`을 전달할 수 있습니다. 취소 신호, 순회 중단, 플러그인 해제는 진행 중인 요청을 취소합니다. HTTP 오류는 SDK 오류(`status` 포함)를 유지하고 자동 재시도는 하지 않습니다.

## 입력과 이벤트

- `LLMRequest.webSearch: true`는 함수 도구와 함께 `{ type: 'web_search_20250305', name: 'web_search' }`를 등록합니다. false/생략은 등록하지 않습니다. 서버의 검색 호출·결과는 로컬 실행용 `TOOL_CALL_*`로 변환하지 않습니다.
- `reasoning: true`는 출력 예산의 절반을 thinking 예산으로 지정합니다(최소 1024, 최대 10000). false는 `{ type: 'disabled' }`을 지정합니다. 생략하면 기존 공급자 기본값을 유지합니다. true는 Anthropic 최소 예산에 따라 `maxOutputTokens > 1024`가 필요합니다. 추론도 기존 `max_tokens` 안에 포함됩니다. 모델은 선택한 검색·thinking 옵션을 지원해야 하며 API 오류는 그대로 전달합니다. 토큰 계산에도 같은 도구·thinking 설정을 사용합니다.
- 웹 검색 인용은 `{ type: 'CUSTOM', name: 'keundal.source', value: { id, url, title? } }`로 전달합니다. `id`는 URL이며 반복 인용은 반복 이벤트가 될 수 있습니다.
- `TEXT_MESSAGE_END.metadata['anthropic.contentBlocks']`는 **SDK 콘텐츠 블록 배열**입니다. 검색 전용 어시스턴트 호스트는 `[ServerToolUseBlock]` 또는 `[WebSearchToolResultBlock]`을, 인용 텍스트 호스트는 `[TextBlock]`을 보존합니다. `input`, `tool_use_id`, 결과의 `encrypted_content`, 인용의 `encrypted_index` 등 원본 필드를 유지합니다. 후속 변환은 이 배열을 텍스트 대신 재생하고 함수 호출을 뒤에 추가하며, 인접 어시스턴트 블록을 합칩니다. 메시지 순서·메타데이터와 기존 추론 `encryptedValue`를 함께 유지해야 서명과 검색 문맥을 복원할 수 있습니다. `pause_turn` 자동 재개는 하지 않고 기존처럼 오류로 전달합니다.
- 시스템·개발자 메시지는 최상위 `system` 텍스트 블록으로 전달합니다. 사용자 입력은 텍스트와 이미지 URL·base64를 지원합니다. 문서·음성·동영상, 이미지 파일 ID, `activity` 메시지는 오류로 알립니다.
- `input.context`는 사용자 역할의 JSON 메시지로 전달합니다. `state`와 `forwardedProps`는 공급자 요청에 자동으로 포함하지 않습니다.
- 어시스턴트의 함수 호출은 `tool_use`로, 도구 결과는 `tool_result`로 변환합니다. 함수 호출 인자는 JSON 객체여야 합니다. 연속된 도구 결과는 하나의 사용자 메시지로 묶고 대응하는 호출을 확인합니다.
- 텍스트는 `TEXT_MESSAGE_*`, 도구 호출은 `TOOL_CALL_*`, 추론은 `REASONING_*` 이벤트로 전달합니다. 도구를 실행하지 않습니다.
- 추론 서명과 `redacted_thinking` 데이터는 `REASONING_ENCRYPTED_VALUE`로 전달합니다. 후속 요청을 구성하는 쪽에서 `reasoning` 메시지의 `content`와 `encryptedValue`, 메시지 순서를 보존해야 합니다. `encryptedValue`는 공급자와 블록 종류를 구분하는 JSON 문자열이므로 수정하지 않고 재사용합니다.
- `end_turn`, `tool_use`, `stop_sequence` 종료 사유와 `message_stop`을 모두 확인해야 성공으로 처리합니다. `max_tokens`, `refusal`, `pause_turn` 등 다른 종료 사유, 완료 이벤트 없는 스트림 종료, 미완료 블록은 예외로 전달합니다.

생성 요청에는 출력 예산을 `max_tokens`로 지정합니다. 대화와 문맥 축약은 Keundal 측에서 관리합니다. `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR`는 생성하지 않으며, journal·커밋·복구도 수행하지 않습니다. 전체 에이전트를 실행하려면 저장소 플러그인과 `@keundal/plugin-agent-simple`을 함께 등록합니다.

## 검증

`pnpm test --filter=@keundal/plugin-llm-anthropic`은 실제 SDK와 로컬 HTTP 서버를 사용합니다. 요청 본문, 토큰 계산, SSE 변환, 추론 서명 보존, 오류, 취소와 플러그인 해제를 검증하며, 실제 Anthropic 계정의 인증·모델 접근 권한은 검증하지 않습니다.
