# Keundal Web · Nuxt UI Chat

[Nuxt UI Chat](https://github.com/nuxt-ui-templates/chat)의 화면·컴포넌트·스타일을 사용합니다. 대화·제목·검색·추론·도구 실행은 Keundal이 담당하고, AI SDK의 Vue 클라이언트·메시지 타입·전송 규격만 템플릿 호환용으로 유지합니다. AI Gateway와 AI SDK 생성·도구 실행 API는 사용하지 않습니다.

## 실행

저장소 루트에서 실행합니다. Node.js와 pnpm 버전은 루트 `package.json`을 따릅니다.

```sh
pnpm install
pnpm build
cp apps/web/.env.example apps/web/.env
pnpm --filter @keundal/web dev
```

`NUXT_SESSION_PASSWORD`는 32자 이상이어야 합니다. 사이드바 **LLM settings**에서 공급자를 선택하고 API 키를 입력한 뒤 **Save in this browser**로 저장합니다. 채팅 입력창에서 사용할 모델을 선택합니다. 선택한 모델의 키만 있으면 제목과 답변을 모두 생성할 수 있습니다. `apps/server`를 별도로 실행하거나 데이터베이스를 마이그레이션할 필요는 없습니다.

| 모델 목록 API | 설정의 공급자 |
| --- | --- |
| `/v1/models` | Anthropic |
| `/v1beta/models` | Google Gemini |
| `/models` (기본 base URL은 `/v1` 포함) | OpenAI |

키를 설정한 공급자의 모델 목록을 시작 시·설정 변경 시·선택기를 열 때 자동으로 불러옵니다. 공급자별 모델 메타데이터는 localStorage에 1시간 캐시하며 키·API 주소의 SHA-256 식별자로 범위를 구분합니다. 캐시에 키를 복제하지 않으며 다른 설정의 목록을 재사용하지 않습니다. **Refresh models**는 유효기간과 관계없이 새로 불러옵니다. Anthropic·Gemini는 모든 페이지를 합치고 Gemini의 embedding 전용 모델은 제외합니다. 조회 실패는 선택기에 안내하며, 저장한 선택은 유지합니다. 미설정 상태에서는 기본 선택만 보이고, 실제 목록은 API 키 설정 후 표시됩니다.

공급자마다 API 키와 선택적인 API base URL을 설정할 수 있습니다. 빈 URL은 공식 엔드포인트를 사용하며, 사용자 지정 주소는 HTTPS(로컬 개발은 HTTP loopback 허용)와 브라우저 CORS를 지원해야 합니다. 설정 저장·삭제는 진행 중 채팅을 중단하며 다음 요청부터 즉시 반영됩니다. **Forget provider**는 해당 공급자의 키·URL과 모델 캐시를 삭제합니다. 앱 예산의 상한은 컨텍스트 128,000·출력 4096 토큰이며, 모델 목록이 더 작은 한도를 제공하면 제목과 답변에도 적용합니다. 한도를 제공하지 않는 OpenAI 등은 이 앱 예산을 사용하며 실제 모델 한도를 보장하지 않습니다. 공급자 오류를 자동 재시도하지 않습니다. Stop과 연결 종료는 공급자 요청에 취소 신호를 전달합니다.

목록에 나온 모델이라고 모든 채팅 기능을 지원하는 것은 아닙니다. OpenAI는 Responses API·입력 토큰 계산, Anthropic은 Messages API·토큰 계산, Gemini는 generateContent·토큰 계산을 지원해야 하며 도구·검색·추론 호환성도 모델마다 다릅니다. 이미지·음성·embedding 전용 모델 등은 현재 텍스트 채팅에 사용할 수 없습니다. 기존 대화의 모델 별칭은 계속 처리합니다.

키·URL은 현재 origin의 `localStorage`에 **암호화 없이** 저장합니다. 같은 사이트의 스크립트나 브라우저 확장 기능이 읽을 수 있으므로 공용 브라우저에서 사용하지 마세요. 선택한 모델도 브라우저에 저장하며, 설정은 계정에 동기화하지 않습니다. 앱 서버의 환경 변수·쿠키·SSR payload에는 키를 넣지 않습니다. 브라우저가 공급자 또는 설정한 엔드포인트로 직접 키와 대화를 전송하므로 신뢰할 수 있는 주소만 사용하세요. CORS가 차단되면 오류로 알리며 서버 프록시로 우회하지 않습니다.

## 저장소와 실행 경계

- 브라우저의 Cordis Context에 `@keundal/plugin-store-indexeddb`와 런타임 설정을 읽는 `llm` 서비스를 등록합니다. `simpleAgentPlugin`이 입력 예산 검사·도구 실행·후속 생성을 수행하고, `session`과 `generation`이 대화·실행 journal을 IndexedDB `keundal-web`에 저장합니다.
- 기존 OpenAI·Anthropic·Gemini 플러그인이 브라우저에서 모델 한도·토큰 계산·스트림을 제공합니다. OpenAI·Anthropic SDK는 명시적인 브라우저 실행 opt-in을 사용합니다. `/api/llm` 프록시는 없으며 서버 DB, D1, R2, NuxtHub도 사용하지 않습니다. 키·URL은 생성 요청이나 journal에 넣지 않고, 키가 반사될 수 있는 공급자 오류 원문도 저장·표시하지 않습니다.
- 제목·투표·UI 메시지·첨부 이미지는 `session.state.web`에 보관합니다. 정규 AG-UI 대화는 `session.messages`에 저장합니다. 웹 앱은 저장소 내부 API나 독자적인 IndexedDB 테이블을 사용하지 않습니다.
- 이미지(파일당 최대 8MB)는 data URL로 저장하므로 새로고침 후에도 유지됩니다. 로그인은 필요하지 않습니다. PDF·CSV 등 미지원 형식은 오류로 알립니다.
- 재접속 시 `generation.recover()`가 저장된 부분 응답을 복원합니다. 미완료 실행은 `interrupted`이며 LLM 재호출·자동 재시도는 하지 않습니다. 마지막 journal 저장 이후의 조각은 유실될 수 있습니다.
- 데이터는 **현재 브라우저·origin에만** 존재합니다. 브라우저 데이터 삭제·저장소 축출 시 사라질 수 있으며 다른 기기나 로그인 계정으로 동기화되지 않습니다. 공개 링크 공유는 비활성화합니다. 기존 서버 SQLite 데이터는 자동 이전하지 않습니다.

### 저장소 교체 계약

`ChatStore`는 공개 `SessionService`·`GenerationService`만 사용합니다. 같은 실행 환경에서 저장소 플러그인 등록만 바꾸면 앱/에이전트 로직을 유지할 수 있습니다. 웹 테스트는 동일한 시나리오를 memory·IndexedDB·SQLite에 적용합니다. SQLite는 Node.js 대상이므로 브라우저에서 import하는 방식으로 교체할 수는 없으며, 서버로 배치할 때도 동일 서비스 계약을 사용해야 합니다. 서로 다른 저장소의 데이터 이전은 별도입니다.

- `session.commit()`은 기본적으로 메시지를 병합합니다. 편집·재생성처럼 뒤의 메시지를 제거할 때는 `mode: 'replace'`로 전체 배열(빈 배열 포함)을 교체합니다. revision 검사는 동일합니다.
- `session.delete(threadId, expectedRevision)`는 스레드·관련 실행·journal을 원자적으로 삭제합니다. 실행 중이면 거부하므로 호출자가 먼저 중단해야 합니다. 영구 tombstone은 남기지 않습니다.
- 신규 저장소 구현도 위 계약을 구현해야 합니다. 기존 `commit()` 호출의 병합 동작은 달라지지 않습니다.

## 검색·추론·받아쓰기

- Web search는 OpenAI/Anthropic 내장 검색을 사용하고 URL 출처·후속 요청용 검색 블록을 보존합니다. 원본 템플릿과 마찬가지로 Gemini에서는 함수 도구와 검색을 함께 등록하지 않습니다.
- Extended thinking은 Keundal `reasoning` 옵션으로 전달합니다. 켜면 OpenAI medium·Anthropic thinking 예산·Gemini 3 high를 사용합니다. 끄면 Anthropic disabled·GPT-5 Nano minimal(검색 시 low)·Gemini 3 Flash minimal이며, 후자의 두 모델은 추론을 완전히 끌 수 없습니다.
- 서명된 추론·검색 블록은 다음 턴에도 유지하고 다른 모델로 전환하면 공급자 전용 상태를 제거합니다. chart/weather 도구를 지원하며 weather는 원본 템플릿의 데모 데이터입니다.
- 받아쓰기는 브라우저의 OpenAI 설정과 `@keundal/plugin-transcription-openai`로 단기 자격 증명을 직접 발급하고 PCM16 24kHz를 스트리밍합니다. 로그인은 필요하지 않으며 모델은 `gpt-4o-mini-transcribe`입니다. 사용자 지정 OpenAI 주소는 Realtime REST·WebSocket도 지원해야 합니다.
- 로컬 공급자 fixture로 프로토콜과 취소·도구 후속 요청을 검증합니다. 실제 유료 API의 모델 접근 권한·검색 결과·음성 인식 품질은 별도 확인이 필요합니다.

## GitHub 로그인 (선택)

사이드바의 로그인 진입 버튼은 표시하지 않습니다. 기존 로그인 세션과 선택적인 OAuth 경로는 유지하며, 로그인해도 로컬 대화를 서버로 올리거나 동기화하지 않습니다. OAuth 경로를 사용하려면 GitHub OAuth 앱과 아래 비밀 값을 설정합니다.

```dotenv
NUXT_OAUTH_GITHUB_CLIENT_ID=
NUXT_OAUTH_GITHUB_CLIENT_SECRET=
NUXT_SESSION_PASSWORD=
```

OAuth callback URL은 앱 도메인의 `/auth/github`입니다.

## Cloudflare Workers

DB·Blob 바인딩 없이 module Worker `keundal-web`으로 배포합니다. API 토큰은 셸/CI의 비밀 환경 변수 `CLOUDFLARE_API_TOKEN`으로 전달하고 필요하면 `CLOUDFLARE_ACCOUNT_ID`로 계정을 선택합니다. 비밀 값은 커밋하지 않습니다. 기존 Worker를 덮어쓰기 전에 계정·이름을 확인합니다.

```sh
pnpm build
pnpm --filter @keundal/web build:cloudflare
pnpm --filter @keundal/web exec wrangler deploy --dry-run --config .output/server/wrangler.json
pnpm --filter @keundal/web deploy:cloudflare
```

OAuth를 사용할 경우 런타임 세션 비밀 값(32자 이상)을 비공개 프롬프트에서 등록합니다. LLM 공급자 키는 Worker에 등록하지 않고 각 사용자가 웹 설정에서 입력합니다.

```sh
pnpm --filter @keundal/web exec wrangler secret put NUXT_SESSION_PASSWORD --config .output/server/wrangler.json
```

공개 앱도 사용자 자신의 키로 직접 요청합니다. 공급자의 비용·권한·브라우저 접근 정책은 해당 키 소유자가 관리해야 합니다.

## 검증

```sh
pnpm --filter @keundal/web test
pnpm --filter @keundal/web typecheck
pnpm --filter @keundal/web lint
```

원본 UI의 ESLint 설정을 사용하며 루트 Oxfmt로 웹 소스를 재포맷하지 않습니다.
