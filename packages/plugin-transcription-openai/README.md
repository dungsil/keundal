# @keundal/plugin-transcription-openai

OpenAI SDK의 `realtime.clientSecrets.create()`로 브라우저용 단기 자격 증명을 발급하는 Cordis 플러그인입니다. Vercel Gateway를 사용하지 않습니다.

```ts
import { Context } from 'cordis'
import openaiTranscriptionPlugin from '@keundal/plugin-transcription-openai'

const ctx = new Context()
const fiber = await ctx.plugin(openaiTranscriptionPlugin, {
  apiKey: process.env.OPENAI_API_KEY!,
  baseURL: process.env.OPENAI_BASE_URL // 선택: 기본값 https://api.openai.com/v1
})
try {
  const session = await ctx.transcription.createSession(
    {
      model: 'gpt-4o-mini-transcribe',
      expiresAfterSeconds: 300
    },
    { signal }
  )
  // 인증과 CSRF 검사를 거친 클라이언트에만 session을 반환합니다.
} finally {
  await fiber.dispose()
}
```

`TranscriptionSession`에는 `clientSecret`, `expiresAt`(Unix 초), WebSocket `url`, 인증용 `protocols`, mono PCM16 24kHz `audio` 설정만 포함됩니다. 서버 API 키는 반환하지 않습니다. TTL은 새 연결의 인증 유효기간이지 녹음 시간 제한이 아닙니다. 자격 증명은 만료 전 재사용될 수 있으므로 발급 경로에 필요한 인증과 사용량 제한을 적용하세요. `baseURL`을 바꾸면 같은 경로의 `/realtime?intent=transcription` WebSocket 엔드포인트를 사용합니다. 호환 서버는 REST와 WebSocket 프로토콜을 모두 지원해야 합니다.

사용자 자신의 키로 브라우저에서 직접 발급하려면 플러그인에 `apiKey`와 `dangerouslyAllowBrowser: true`를 명시합니다. 생략하면 SDK의 브라우저 실행 차단을 유지합니다. 키 노출 위험을 안내하고 엔드포인트의 CORS 지원을 확인해야 하며, 서버 소유 비밀 키를 번들에 넣으면 안 됩니다.

선택적인 `headers: Record<string, string>`는 자격 증명 발급 HTTP 요청의 SDK `defaultHeaders`에 전달합니다. 브라우저의 CORS·금지 헤더 제한은 그대로 적용됩니다. 이 헤더는 반환되는 세션에 포함하지 않으며 브라우저 WebSocket 연결에도 전송하지 않습니다.

발급된 단기 자격 증명으로 스트리밍할 때는 SDK/Cordis 런타임을 가져오지 않는 별도 진입점을 사용합니다.

```ts
import { streamTranscription, resampleAudio, encodeRealtimeAudio } from '@keundal/plugin-transcription-openai/client'

const result = streamTranscription({ session, audio, signal })
for await (const part of result.fullStream) {
  // transcript-delta: 새 delta
  // transcript-final: 발화 순서로 확정된 text
  // transcript-partial: 아직 확정 전달되지 않은 모든 발화의 교체용 text
}
const text = await result.text
```

`audio`는 base64 mono little-endian PCM16 문자열의 `ReadableStream<string>`입니다. `resampleAudio()`는 Float32 mono 입력을 선형 보간하고 `encodeRealtimeAudio()`는 [-1, 1] 클리핑 후 PCM16으로 인코딩합니다. 마이크 수집과 브라우저 자원 정리는 호출자가 담당합니다.

오디오는 즉시 WebSocket에 전송하며 약 2초마다 수동 commit합니다(`turn_detection: null`). 따라서 녹음 종료 전에도 부분·최종 결과가 도착합니다. 오디오 스트림을 닫으면 마지막 버퍼를 commit하고 모든 최종 결과를 기다립니다. 100ms 미만의 마지막 버퍼는 무음으로 패딩하고, 빈 버퍼는 commit하지 않습니다. 서로 다른 발화의 완료 순서가 뒤바뀌어도 최종 문자열은 commit 순서를 유지합니다. delta와 partial을 함께 소비할 때 partial은 누적하지 않고 교체해야 합니다.

취소 신호, 소비 순회 중단, 공급자 오류, 예상치 못한 연결 종료는 연결·오디오 reader·리스너·타이머를 정리합니다. 연결과 stop 후 최종화 제한은 각각 기본 15초이며 `timeoutMs`로 설정합니다. `text`와 이벤트 순회 모두 오류를 전달합니다. 서비스 해제는 진행 중 자격 증명 발급을 취소하지만 이미 발급한 브라우저 자격 증명을 폐기하지는 않습니다.

검증 기준: 설치된 OpenAI SDK 7.15.0 타입과 공식 [client secrets](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets), [WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets?api=realtime), [transcription](https://developers.openai.com/api/docs/guides/realtime-transcription) 문서. 실제 모델의 지연과 인식 품질은 로컬 프로토콜 fixture 테스트로 보장하지 않습니다. 수동 턴 경계는 발화 중간에 생길 수 있습니다.
