# Keundal Web · Nuxt UI Chat

[Nuxt UI Chat](https://github.com/nuxt-ui-templates/chat)의 화면·컴포넌트·스타일을 사용합니다. 대화·제목·검색·추론·도구 실행과 Vue 채팅 상태 관리는 프로젝트 내부의 Cordis·AG-UI 기반 구현이 담당합니다. Vercel AI SDK·AI Gateway·UI Message Stream 규격은 사용하지 않습니다. 공급자 연결에는 공식 OpenAI·Anthropic·Gemini SDK를 사용합니다.

화면과 채팅 실행 코드는 [공용 채팅 레이어](../../packages/chat-app/README.md)에 있습니다. 웹 앱은 이 레이어를 상속하고 웹 서버와 Cloudflare 배포 설정을 관리합니다. 다른 앱에는 의존하지 않습니다.

## 실행

저장소 루트에서 실행합니다. Node.js와 pnpm 버전은 루트 `package.json`을 따릅니다.

```sh
pnpm install
pnpm build
pnpm --filter @keundal/web dev
```

사이드바 **LLM settings**에서 공급자를 선택하고 API 키나 API 주소를 입력한 뒤 **Save in this browser**로 저장합니다. 채팅 입력창에서 사용할 모델을 선택합니다. 인증이 필요 없는 호환 엔드포인트는 API 키를 비워 두어도 제목과 답변을 생성할 수 있습니다. 브라우저 모드에는 데이터베이스 마이그레이션이 필요하지 않습니다.

| 모델 목록 API | 설정의 공급자 |
| --- | --- |
| `/v1/models` | Anthropic |
| `/v1beta/models` | Google Gemini |
| `/models` (기본 base URL은 `/v1` 포함) | OpenAI Responses·Chat Completions |

키·API 주소·커스텀 헤더 중 하나 이상을 설정한 공급자의 모델 목록을 시작 시·설정 변경 시·선택기를 열 때 자동으로 불러옵니다. 공급자별 모델 메타데이터는 localStorage에 1시간 캐시하며 키·API 주소·커스텀 헤더의 SHA-256 식별자로 범위를 구분합니다. 캐시에 키·헤더를 복제하지 않으며 다른 설정의 목록을 재사용하지 않습니다. **Refresh models**는 유효기간과 관계없이 새로 불러옵니다. Anthropic·Gemini는 모든 페이지를 합치고 Gemini의 embedding 전용 모델은 제외합니다. 조회 실패는 선택기에 안내하며, 저장한 선택은 유지합니다. 미설정 상태에서는 기본 선택만 보이고, 실제 목록은 공급자 설정 후 표시됩니다.

공급자마다 선택적인 API 키와 API base URL을 설정할 수 있습니다. API 키를 비워 두면 모델 조회·토큰 계산·제목·답변 요청에서 기본 인증 헤더를 보내지 않으며, 커스텀 인증 헤더는 그대로 적용합니다. 빈 URL은 공식 엔드포인트를 사용하며, 사용자 지정 주소는 HTTPS(로컬 개발은 HTTP loopback 허용)와 브라우저 CORS를 지원해야 합니다. 설정 저장·삭제는 진행 중 채팅을 중단하며 다음 요청부터 즉시 반영됩니다. **Forget provider**는 해당 공급자의 키·URL과 모델 캐시를 삭제합니다. 앱 예산의 상한은 컨텍스트 128,000·출력 4096 토큰이며, 모델 목록이 더 작은 한도를 제공하면 제목과 답변에도 적용합니다. 한도를 제공하지 않는 OpenAI 등은 이 앱 예산을 사용하며 실제 모델 한도를 보장하지 않습니다. 공급자가 실제 컨텍스트 초과를 알리면 첫 응답 이벤트 전에만 축약 후 한 번 재시도합니다. 답변 생성의 HTTP 429·일시적 5xx·연결 오류는 응답 이벤트 전달 전에만 기본 두 번 재시도하며, 전체 턴이나 완료된 도구를 다시 실행하지 않습니다. 인증·잘못된 요청·부분 응답 이후의 오류는 그대로 전달합니다. Stop과 연결 종료는 공급자 요청과 재시도 대기에 취소 신호를 전달합니다. 대체 모델 체인과 호환성 검사는 [공통 루프 문서](../../packages/agent-loop/README.md#모델-요청-재시도와-대체-모델)를 참고합니다.

**설정 → 모델 설정**에서 대체 모델을 중복 없이 최대 8개 지정하고 위·아래 버튼으로 순서를 바꿀 수 있습니다. 모델별 재시도 횟수는 0~5, 첫 대기 시간과 재시도별 최대 대기 시간은 0~60,000 ms의 정수이며 첫 대기 시간은 최대 대기 시간 이하여야 합니다. 0회로 설정해도 대체 모델 체인은 유지합니다. 저장한 정책은 이 브라우저의 `keundal:model-recovery`에 보관하고 다음 실행에 적용합니다. 진행 중인 실행과 원격 실행의 재구독은 바꾸지 않으며 제목 생성에는 적용하지 않습니다. 원격 연결은 호스트가 제공하는 모델 ID로 변환해 전달하며 호스트에 없는 모델은 사용할 수 없습니다. 실행 추적에서는 각 시도의 모델·성공·실패 상태를 확인하고, 모델이 달라진 단계의 **모델 전환**에서 이전 모델과 새 모델을 확인합니다.

브라우저 연결은 모델 목록 항목의 선택적 `capabilities: { tools, reasoning, webSearch }`를 캐시와 실행 서비스까지 보존합니다. 형식은 공통 루프의 모델 기능 계약과 같습니다. 공급자 목록에 이 정보가 없거나 다른 형식이면 지원 여부를 추정하지 않습니다. 도구·추론·검색을 요구하는 요청은 해당 기능의 호환성이 확인되지 않은 대체 모델을 건너뜁니다. 따라서 모델 목록에 표시되거나 체인에 저장됐다는 이유만으로 전환을 보장하지 않습니다. 원격 연결에서는 호스트의 모델 설정이 이 정보를 제공해야 합니다.

목록에 나온 모델이라고 모든 채팅 기능을 지원하는 것은 아닙니다. OpenAI는 Responses API 또는 Chat Completions API, Anthropic은 Messages API·토큰 계산, Gemini는 generateContent·토큰 계산을 지원해야 하며 도구·검색·추론 호환성도 모델마다 다릅니다. OpenAI Responses API의 `/responses/input_tokens` 호출이 실패하면 호환 모드에서 생성 입력 JSON의 UTF-8 바이트 수로 추정해 생성을 계속합니다. Chat Completions API에는 입력 토큰 계산 API가 없어 생성 요청 본문의 UTF-8 바이트 수로 추정합니다. 실제 토큰 수나 이미지 비용을 보장하지 않으며 입력 예산 검사·축약은 유지합니다. 웹은 공급자 서비스를 작업마다 새로 만들므로 다음 토큰 계산에서는 API 지원 여부를 다시 확인합니다. 취소·입력 검증 오류와 실제 생성 요청의 오류는 숨기지 않습니다. 이미지·음성·embedding 전용 모델 등은 현재 텍스트 채팅에 사용할 수 없습니다. 기존 대화의 모델 별칭은 계속 처리합니다.

**Request headers (optional)**에서 **Add header**로 행을 추가하고 **Key**·**Value** 입력란에 이름과 값을 입력합니다. 각 행의 삭제 버튼으로 제거하며, 행은 계속 추가할 수 있습니다. 기존에 저장한 헤더도 행으로 불러옵니다. 양쪽이 빈 행은 저장에서 제외하고, 값만 입력한 행은 거부합니다. 이름 앞뒤 공백은 제거하며 이름은 대소문자를 구분하지 않습니다. 중복 이름·잘못된 HTTP 이름·줄바꿈·비 ASCII 값은 저장 전에 거부합니다. 헤더는 기본 인증 헤더도 덮어쓸 수 있고 모델 조회·토큰 계산·제목·답변·받아쓰기 자격 증명 발급에 적용합니다. 브라우저가 금지하는 `Host`·`Cookie` 등의 헤더는 설정할 수 없으며, 사용자 지정 헤더는 엔드포인트의 CORS 허용 목록에도 있어야 합니다. 브라우저 WebSocket에는 임의 HTTP 헤더를 넣을 수 없으므로 받아쓰기 연결에는 적용하지 않습니다. **Forget provider**는 헤더도 삭제합니다.

HTTP 400 오류는 공급자 JSON의 `error.message`·문자열 `error`·`message`를 추출해 최대 1000자로 표시합니다. SDK가 JSON 문자열로 전달하는 Gemini 오류도 처리합니다. 현재 요청의 API 키·URL·헤더 값(인증 scheme을 제외한 토큰 포함)은 가리고 새 오류만 전달하며 원본 객체·응답 헤더·cause는 보존하지 않습니다. 컨텍스트 초과·일시적 오류 여부만 안전한 오류 코드로 보존하고, `Retry-After`는 숫자 대기 시간만 보존하여 에이전트의 재시도에 사용합니다. 파싱할 수 없는 응답과 다른 상태 코드는 기존 일반 안내를 유지합니다. 공급자가 일부만 노출하거나 임의로 변형한 비밀 값까지 식별할 수는 없습니다.

키·URL·헤더는 현재 origin의 `localStorage`에 **암호화 없이** 저장합니다. 같은 사이트의 스크립트나 브라우저 확장 기능이 읽을 수 있으므로 공용 브라우저에서 사용하지 마세요. 선택한 모델도 브라우저에 저장하며, 설정은 계정에 동기화하지 않습니다. 앱 서버의 환경 변수·쿠키·SSR payload에는 키·헤더를 넣지 않습니다. 브라우저가 공급자 또는 설정한 엔드포인트로 직접 키와 대화를 전송하므로 신뢰할 수 있는 주소만 사용하세요. CORS가 차단되면 오류로 알리며 서버 프록시로 우회하지 않습니다.

동일 UI를 사용하는 [데스크톱 앱](../desktop/README.md)은 LLM 설정을 localStorage 대신 OS 보안 저장소에 저장합니다. 위 브라우저 저장 안내는 웹 앱에 해당하며, 공급자 직접 요청과 CORS 정책은 데스크톱에도 적용됩니다.

## 웹 서버의 에이전트 모드

웹 앱은 기본으로 브라우저에서 에이전트를 실행합니다. Node.js로 실행하는 Nitro 서버는 `@keundal/agent-host`를 직접 조립하여 `/api/agent/**`에서 대화와 실행을 처리할 수 있습니다. 별도 HTTP 서버나 프록시 주소는 필요하지 않습니다.

```sh
export OPENAI_API_KEY="sk-..."             # 또는 GEMINI_API_KEY, ANTHROPIC_API_KEY
export KEUNDAL_MODEL="gpt-4.1-mini"
export KEUNDAL_API_TOKEN="your-random-bearer-token"
export KEUNDAL_SQLITE_PATH=".data/keundal.sqlite"
export NUXT_PUBLIC_AGENT_ENDPOINT="/api/agent"
export NUXT_PUBLIC_AGENT_TOKEN="$KEUNDAL_API_TOKEN"
pnpm --filter @keundal/web build
pnpm --filter @keundal/web preview
```

호스트는 첫 API 요청 때 만들어지고 같은 웹 서버 프로세스에서 재사용합니다. 서버가 종료되면 호스트도 정리합니다. 모델 공급자의 키는 서버 환경 변수에서 읽으며 브라우저에 전달하지 않습니다. 호스트 설정이 없으면 API는 `503`을 반환하며 브라우저 모드는 계속 사용할 수 있습니다.

모든 API 요청에는 `Authorization: Bearer <토큰>`이 필요합니다. 위 UI 설정의 `NUXT_PUBLIC_AGENT_TOKEN`은 브라우저에 전달되므로 이 모드는 신뢰할 수 있는 단일 사용자 환경에서 사용합니다. 토큰을 가진 호출자는 호스트의 모든 대화와 실행 기록에 접근합니다. 외부에 공개할 때는 접근 제어와 TLS를 별도로 구성해야 합니다. 다른 origin에서 직접 호출하려면 `KEUNDAL_CORS_ORIGINS`에 허용할 origin을 추가합니다.

| API 경로 | 동작 |
| --- | --- |
| `POST /api/agent/runs` | AG-UI 실행을 SSE로 전달합니다. `x-keundal-model` 헤더로 모델을 선택합니다. |
| `GET /api/agent/models` | 호스트에 등록한 모델과 한도를 조회합니다. |
| `POST /api/agent/title` | 첫 사용자 메시지로 제목을 생성합니다. |
| `GET /api/agent/threads`와 `GET /api/agent/threads/:id` | 대화 목록과 스냅숏을 조회합니다. |
| `PUT /api/agent/threads/:id` | 기준 revision과 메시지·상태를 받아 대화를 저장합니다. |
| `DELETE /api/agent/threads/:id?revision=N` | 기준 revision과 일치하는 대화를 삭제합니다. |
| `GET /api/agent/runs`와 `GET /api/agent/runs/:id` | 실행 목록과 스냅숏을 조회합니다. |
| `POST /api/agent/recover` | 미완료 실행을 `interrupted`로 확정합니다. |

요청 본문은 기본 8 MiB까지 허용하며 `KEUNDAL_MAX_REQUEST_BODY_BYTES`로 변경합니다. 상한을 넘는 요청은 JSON 파싱과 에이전트 실행 전에 `413`으로 거부합니다. `KEUNDAL_PROVIDER`, `KEUNDAL_CONTEXT_WINDOW`, `KEUNDAL_MAX_OUTPUT_TOKENS`, `KEUNDAL_BASE_URL`, `KEUNDAL_HEADERS`로 공급자와 모델 설정을 지정할 수 있습니다.

호스트 모드에서는 대화·실행·제목이 SQLite에 저장되고 모델 목록도 호스트에서 조회합니다. UI의 API 키 설정은 호스트 설정을 바꾸지 않습니다. Cloudflare Workers에서는 Node.js SQLite 호스트를 포함하지 않으며 이 API는 `503`을 반환합니다. Workers의 브라우저 모드와 외부 호스트 직접 연결은 유지합니다.

데스크톱은 웹 서버를 실행하지 않습니다. `apps/desktop/sidecar/main.ts`가 `@keundal/agent-runtime-node`을 직접 사용하며, UI는 준비된 로컬 호스트에 연결합니다.

## 저장소와 실행 경계

- 브라우저의 Cordis Context에 `@keundal/plugin-store-indexeddb`와 런타임 설정을 읽는 `llm` 서비스를 등록합니다. `agentPlugin`이 입력 예산 검사·도구 실행·후속 생성을 수행하고, `session`과 `generation`이 대화·실행 journal을 IndexedDB `keundal-web`에 저장합니다.
- 기존 OpenAI·Anthropic·Gemini 플러그인이 브라우저에서 모델 한도·토큰 계산·스트림을 제공합니다. OpenAI·Anthropic SDK는 명시적인 브라우저 실행 opt-in을 사용합니다. `/api/llm` 프록시는 없으며 서버 DB, D1, R2, NuxtHub도 사용하지 않습니다. 키·URL·헤더는 생성 요청이나 journal에 넣지 않고, 400 오류의 진단 메시지만 위 규칙으로 정제해 전달합니다.
- 제목·투표·UI 메시지·첨부 파일은 `session.state.web`에 보관합니다. 정규 AG-UI 대화는 `session.messages`에 저장합니다. 웹 앱은 저장소 내부 API나 독자적인 IndexedDB 테이블을 사용하지 않습니다.
- `ChatStore.respond()`는 HTTP나 SSE로 변환하지 않고 `AsyncIterable<AGUIEvent>`를 반환합니다. `useKeundalChat()`이 전송·중단·편집·재생성 상태를 관리하며 `ChatMessageAssembly`가 텍스트·추론·도구·출처 이벤트를 앱 소유의 `ChatMessage`로 투영합니다. `RUN_FINISHED`는 표시 메시지까지 저장한 뒤 전달합니다. 기존 `session.state.web` 메시지와 `data-keundal`의 정규 대화는 그대로 읽을 수 있습니다.
- 이미지·PDF·CSV·일반 텍스트 파일을 첨부할 수 있습니다. 파일당 최대 8MiB이며, 문서는 추출 텍스트 20만 자와 PDF 200쪽으로 제한합니다. 상한을 넘으면 내용을 자르지 않고 오류로 알립니다. CSV와 일반 텍스트는 UTF-8 인코딩을 사용합니다. 암호로 잠긴 PDF와 텍스트가 없는 스캔 PDF는 지원하지 않으며, 스캔 PDF는 OCR 처리 후 첨부해야 합니다.
- `@keundal/chat/file`의 첨부 저장 계약과 `@keundal/chat/documents`의 형식별 파서를 분리합니다. 브라우저에서 PDF 텍스트와 CSV 셀을 추출하며 외부 파싱 서버를 사용하지 않습니다. 이미지는 data URL을, 문서는 원본 파일이나 URL 대신 파일명·형식·추출 텍스트를 저장하므로 새로고침·대화 분기·백업 복원 후에도 질문할 수 있습니다.
- 문서 내용은 신뢰할 수 없는 참고 데이터로 표시한 사용자 메시지로 모델에 전달하며, 기존 입력 예산 검사와 축약을 거칩니다. 첨부한 텍스트는 선택한 모델 공급자에게 전송되고 대화·실행 기록과 백업에 포함됩니다. 비밀 정보는 첨부 전에 제거해야 하며 자동으로 탐지하거나 지우지 않습니다. API 키·헤더 등 앱의 비밀 설정을 제외하는 기존 백업 규칙은 유지합니다. Markdown 대화 내보내기는 파일명만 포함하고 문서 내용이나 URL을 추가하지 않습니다.
- 재접속 시 `generation.recover()`가 저장된 부분 응답을 복원합니다. 미완료 실행은 `interrupted`이며 LLM 재호출·자동 재시도는 하지 않습니다. 마지막 journal 저장 이후의 조각은 유실될 수 있습니다.
- 데이터는 **현재 브라우저·origin에만** 존재합니다. 브라우저 데이터 삭제·저장소 축출 시 사라질 수 있으며 다른 기기나 로그인 계정으로 동기화되지 않습니다. 공개 링크 공유는 비활성화합니다. 기존 서버 SQLite 데이터는 자동 이전하지 않습니다.

### 저장소 교체 계약

`ChatStore`는 공개 `SessionService`·`GenerationService`만 사용합니다. 같은 실행 환경에서 저장소 플러그인 등록만 바꾸면 앱/에이전트 로직을 유지할 수 있습니다. SQLite는 Node.js 대상이므로 브라우저에서 import하는 방식으로 교체할 수는 없으며, 서버로 배치할 때도 동일 서비스 계약을 사용해야 합니다. 서로 다른 저장소의 데이터 이전은 별도입니다.

- `session.commit()`은 기본적으로 메시지를 병합합니다. 편집·재생성처럼 뒤의 메시지를 제거할 때는 `mode: 'replace'`로 전체 배열(빈 배열 포함)을 교체합니다. revision 검사는 동일합니다.
- `session.delete(threadId, expectedRevision)`는 스레드·관련 실행·journal을 원자적으로 삭제합니다. 실행 중이면 거부하므로 호출자가 먼저 중단해야 합니다. 영구 tombstone은 남기지 않습니다.
- 신규 저장소 구현도 위 계약을 구현해야 합니다. 기존 `commit()` 호출의 병합 동작은 달라지지 않습니다.
- 대화 분기는 `session.get()`으로 원래 대화를 읽고 새 `threadId`에 `session.commit()` 한 번으로 저장합니다. 새 호스트 라우트나 스키마 변경은 없으며 원격 호스트에서는 기존 `GET`·`PUT /threads/:id`를 씁니다. 복사 규칙은 [대화 분기](../../docs/chat-branch.md)를 따릅니다.

## 표시 언어

상단의 언어 선택 메뉴에서 **한국어**와 **English**를 전환합니다. 처음 방문하면 브라우저의 선호 언어를 사용하고, 지원하는 언어가 없으면 영어로 표시합니다. 선택한 언어는 `keundal-locale` 쿠키에 1년 동안 저장하며 다음 방문에도 우선 적용합니다.

메뉴, 설정, 알림, 접근성 문구와 날짜 표시는 선택한 언어를 따릅니다. 사용자가 작성한 대화 제목·메시지·스킬과 공급자가 반환한 진단 내용은 번역하지 않습니다. 표시 언어는 모델의 응답 언어를 강제하지 않습니다.

## 스킬 관리

사이드바의 **Skills**에서 스킬을 생성·편집·삭제하거나 `SKILL.md` 또는 ZIP 파일을 가져옵니다. ZIP은 루트나 하위 폴더에 `SKILL.md`가 한 개 있어야 하며, 스크립트와 참고 자료 등 부속 파일은 저장하지 않습니다. ZIP 파일은 10 MiB, 압축을 푼 `SKILL.md`는 1 MiB까지 지원합니다. 이름, 설명, Markdown 지침을 저장하고 스킬별로 사용 여부를 설정합니다. 가져온 파일은 편집 폼에서 확인한 뒤 **Save skill**로 저장합니다. 원본 파일은 변경하지 않습니다.

설정은 현재 브라우저·origin의 localStorage에 저장하며 계정이나 다른 기기로 동기화하지 않습니다. 변경 사항은 다음 응답부터 적용합니다. 실행을 시작한 응답의 목록은 유지합니다.

에이전트는 사용 중인 스킬의 이름과 설명을 확인하고 `skill` 도구로 필요한 본문을 읽습니다. 대화에는 불러온 스킬 이름과 결과를 표시합니다. 스킬은 모델 지침이며 스크립트나 첨부 파일을 자동 실행하지 않습니다. 신뢰할 수 있는 지침만 추가합니다.

데스크톱 앱은 같은 관리 화면에서 [로컬 `.agents/skills` 파일](../desktop/README.md#로컬-스킬)도 읽습니다.

## 검색·추론·받아쓰기

- Web search는 OpenAI/Anthropic 내장 검색을 사용하고 URL 출처·후속 요청용 검색 블록을 보존합니다. Gemini에서는 함수 도구와 검색을 함께 등록하지 않습니다.
- Extended thinking은 Keundal `reasoning` 옵션으로 전달합니다. 켜면 OpenAI medium·Anthropic thinking 예산·Gemini 3 high를 사용합니다. 끄면 Anthropic disabled·GPT-5 Nano minimal(검색 시 low)·Gemini 3 Flash minimal이며, 후자의 두 모델은 추론을 완전히 끌 수 없습니다.
- 서명된 추론·검색 블록은 다음 턴에도 유지하고 다른 모델로 전환하면 공급자 전용 상태를 제거합니다. chart/weather 도구를 지원하며 weather는 데모 데이터를 사용합니다.
- 받아쓰기는 브라우저의 OpenAI 설정과 `@keundal/plugin-transcription-openai`로 단기 자격 증명을 직접 발급하고 PCM16 24kHz를 스트리밍합니다. 로그인은 필요하지 않으며 모델은 `gpt-4o-mini-transcribe`입니다. 사용자 지정 OpenAI 주소는 Realtime REST·WebSocket도 지원해야 합니다.

## Cloudflare Workers

DB·Blob 바인딩 없이 module Worker `keundal-web`으로 배포합니다. API 토큰은 셸/CI의 비밀 환경 변수 `CLOUDFLARE_API_TOKEN`으로 전달하고 필요하면 `CLOUDFLARE_ACCOUNT_ID`로 계정을 선택합니다. 비밀 값은 커밋하지 않습니다. 기존 Worker를 덮어쓰기 전에 계정·이름을 확인합니다.

```sh
pnpm build
pnpm --filter @keundal/web build:cloudflare
pnpm --filter @keundal/web exec wrangler deploy --dry-run --config .output/server/wrangler.json
pnpm --filter @keundal/web deploy:cloudflare
```

### GitHub Actions 자동 배포

`.github/workflows/ci.yml`은 빌드·플랫폼 빌드·타입 검사·테스트·린트·CodeQL을 실행하고 웹 Workers와 데스크톱 설치 파일을 아티팩트로 보관합니다. 배포 워크플로우는 `workflow_run`으로 CI 성공을 확인한 뒤 해당 CI 실행의 아티팩트를 사용합니다. 배포 단계에서는 소스를 다시 빌드하거나 PR 코드를 checkout하지 않습니다.

`.github/workflows/deploy.yml`은 `main` 푸시와 `main`에서의 수동 CI 실행이 성공하면 운영 Worker `keundal-web`을 배포합니다. 배포 직전에 CI 커밋과 최신 `main` 커밋을 비교하며, 두 커밋이 다르면 배포를 생략합니다.

`.github/workflows/preview.yml`은 같은 저장소의 `main` 대상 PR에서 CI가 성공하면 `preview --name pr-<PR 번호>`로 프리뷰를 만듭니다. PR이 열려 있고 최신 커밋이 CI 커밋과 일치하는지 배포 직전에 다시 확인합니다. 문서 전용 PR처럼 Workers 아티팩트가 없는 실행은 배포하지 않습니다. 같은 PR의 후속 커밋은 같은 프리뷰를 갱신합니다. Workers Previews는 현재 open beta이며 저장소에 고정한 Wrangler 버전을 사용합니다.

PR 프리뷰 배포가 성공하면 `marocchino/sticky-pull-request-comment` Action이 웹 프리뷰 URL, 데스크톱 설치 파일과 CI·배포 실행 링크를 댓글로 남깁니다. 설치 파일 링크는 배포 워크플로우가 아닌 원본 CI 실행의 아티팩트를 가리킵니다. 재배포 시 `cloudflare-preview` 댓글 하나를 갱신하며, 운영 배포나 배포 실패 시에는 댓글을 작성하지 않습니다. 댓글 쓰기 권한은 배포·종료 job에만 부여합니다.

PR을 병합하거나 닫으면 `.github/workflows/cleanup-preview.yml`의 `cleanup-preview` job이 해당 `pr-<번호>` 프리뷰와 모든 배포 이력을 삭제합니다. 기존 댓글도 종료 상태로 갱신합니다. 이미 없는 프리뷰는 성공으로 처리하되 인증·서버 오류는 실패로 남깁니다. 종료 job은 PR 코드를 checkout하거나 실행하지 않으며, 빌드 성공 여부와 무관하게 실행합니다. 프리뷰 배포와 종료는 `preview-<PR 번호>` concurrency 그룹과 `queue: max`를 공유하여 대기 중인 삭제 요청도 보존합니다. PR을 다시 열면 일반 CI 성공 후 프리뷰를 다시 생성합니다.

`workflow_run` 워크플로우는 기본 브랜치에 파일이 있어야 실행되므로 최초 분리 PR에서는 새 배포 워크플로우를 실행하지 않습니다. 병합 후 CI가 완료되면 운영 배포를 시작하며, 이후 PR부터 새 프리뷰를 배포합니다.

저장소의 **Settings → Secrets and variables → Actions**에 다음 secrets를 등록합니다.

| Secret | 값 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 배포할 계정에 한정한 Workers 편집 권한의 API 토큰 |
| `CLOUDFLARE_ACCOUNT_ID` | Worker를 배포할 Cloudflare 계정 ID |

Dependabot PR도 프리뷰를 배포합니다. CI 완료 후의 배포는 Actions secrets를 사용합니다. Dependabot PR 종료 워크플로우를 위해 **Settings → Secrets and variables → Dependabot**에도 같은 이름의 두 secrets를 등록합니다. 값이 없거나 배포에 실패하면 배포 job이 실패하며, 실패를 성공으로 처리하거나 배포를 생략하지 않습니다.

빌드·타입 검사·테스트·린트 필수 검사와 CodeQL 규칙은 기존 CI에서 유지합니다. 배포 결과는 CI 결과와 분리되며, 배포 실패로 CI 검사가 실패하지 않습니다. `workflow_run` 실행은 기본 브랜치에 연결되므로 **PR 프리뷰 배포**를 PR 커밋의 필수 상태 검사로 사용하지 않습니다.

프리뷰 URL은 PR 댓글과 배포 단계 로그에서 확인합니다. 프리뷰는 공개 URL이며 브라우저의 대화·키 저장소는 origin이 다른 운영·각 PR 사이에서 분리됩니다. 새 프리뷰는 운영 secrets·변수·데이터 바인딩을 상속하지 않습니다.

Workers.dev 프리뷰 URL을 사용하려면 `preview_urls: true` 설정을 유지해야 합니다. 이 설정은 `main` 운영 배포에 먼저 반영한 뒤 PR 프리뷰를 배포해야 합니다. `false`이면 프리뷰 생성에 성공해도 활성 URL이 없어 PR 댓글에 링크가 표시되지 않습니다. `preview` 방식으로 만든 프리뷰는 PR 종료 시 개별 삭제하며, 운영 Worker 자체와 정상 운영 URL은 삭제하지 않습니다.

배포 자격 증명을 보호하기 위해 포크 PR은 자동 배포하지 않습니다. `pull_request_target`으로 PR 코드를 실행하지 않으며, 같은 저장소의 PR 코드는 배포 권한을 가진 신뢰된 코드로 취급합니다. CI 검사가 실패하거나 문서 전용 PR처럼 검사가 생략되면 배포하지 않습니다. GitHub는 생략된 job을 필수 검사 실패로 취급하지 않으므로 포크·문서 전용 PR에 프리뷰 성공을 강제하지는 않습니다.

LLM 공급자 키는 Worker에 등록하지 않고 각 사용자가 웹 설정에서 입력합니다.

공개 앱도 사용자 자신의 키로 직접 요청합니다. 공급자의 비용·권한·브라우저 접근 정책은 해당 키 소유자가 관리해야 합니다.

## 검증

```sh
pnpm build
pnpm --filter @keundal/chat-app test
pnpm --filter @keundal/web test
pnpm --filter @keundal/web typecheck
pnpm --filter @keundal/web lint
```

## 선제적 축약

컨텍스트 사용량이 입력 예산의 80%에 도달하면 백그라운드에서 축약을 준비합니다. `ChatStore`는 같은 대화와 모델·생성 설정의 에이전트를 턴 사이에 유지하여 다음 입력 검사에서 준비 결과를 재사용합니다. 준비 결과는 원본 대화와 지침을 검사하고 새 메시지와 현재 화면 상태를 보존합니다.

대화 삭제와 전체 중단 시 에이전트와 준비 작업을 해제합니다. 모델·생성 설정이 바뀌면 해당 대화의 에이전트를 교체하며, 대기 중인 에이전트가 누적되지 않도록 최대 8개를 기준으로 오래된 유휴 에이전트부터 해제합니다. 실행 중인 다른 대화는 중단하지 않습니다. `createKeundalChat()`을 직접 사용하는 호출자는 작업을 마친 뒤 `dispose()`를 호출해야 합니다.

브라우저는 `/keundal.plugins.json`에서 LLM·저장소·에이전트·도구 구성을 읽습니다. 배포한 JSON과 외부 ESM 파일을 수정하면 앱을 다시 빌드하지 않고 구현을 교체할 수 있습니다. `NUXT_PUBLIC_PLUGIN_CONFIG`로 설정 URL을 변경합니다. Node.js 호스트는 `KEUNDAL_PLUGIN_CONFIG`로 로컬 설정 파일을 선택합니다. 변경 후 브라우저는 새로고침하고 호스트는 다시 시작합니다. 형식과 신뢰 경계는 [플러그인 조립 문서](../../docs/plugin-composition.md#런타임-설정)를 참고합니다.

## MCP

브라우저 실행 모드에서는 **Settings → MCP**에서 Streamable HTTP 서버를 등록합니다. 서버가 앱 origin의 CORS 접근을 허용해야 합니다. Node.js 에이전트 호스트 모드에서는 서버의 `KEUNDAL_MCP_SERVERS` 환경 변수로 설정합니다. [공용 MCP 설정 안내](../../packages/chat-app/README.md#mcp-서버)를 참고합니다.
