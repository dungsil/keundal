# Keundal Web · Nuxt UI Chat

[Nuxt UI Chat](https://github.com/nuxt-ui-templates/chat)의 화면·컴포넌트·스타일을 사용합니다. 대화·제목·검색·추론·도구 실행과 Vue 채팅 상태 관리는 프로젝트 내부의 Cordis·AG-UI 기반 구현이 담당합니다. Vercel AI SDK·AI Gateway·UI Message Stream 규격은 사용하지 않습니다. 공급자 연결에는 공식 OpenAI·Anthropic·Gemini SDK를 사용합니다.

## 실행

저장소 루트에서 실행합니다. Node.js와 pnpm 버전은 루트 `package.json`을 따릅니다.

```sh
pnpm install
pnpm build
pnpm --filter @keundal/web dev
```

사이드바 **LLM settings**에서 공급자를 선택하고 API 키를 입력한 뒤 **Save in this browser**로 저장합니다. 채팅 입력창에서 사용할 모델을 선택합니다. 선택한 모델의 키만 있으면 제목과 답변을 모두 생성할 수 있습니다. `apps/server`를 별도로 실행하거나 데이터베이스를 마이그레이션할 필요는 없습니다.

| 모델 목록 API | 설정의 공급자 |
| --- | --- |
| `/v1/models` | Anthropic |
| `/v1beta/models` | Google Gemini |
| `/models` (기본 base URL은 `/v1` 포함) | OpenAI |

키를 설정한 공급자의 모델 목록을 시작 시·설정 변경 시·선택기를 열 때 자동으로 불러옵니다. 공급자별 모델 메타데이터는 localStorage에 1시간 캐시하며 키·API 주소·커스텀 헤더의 SHA-256 식별자로 범위를 구분합니다. 캐시에 키·헤더를 복제하지 않으며 다른 설정의 목록을 재사용하지 않습니다. **Refresh models**는 유효기간과 관계없이 새로 불러옵니다. Anthropic·Gemini는 모든 페이지를 합치고 Gemini의 embedding 전용 모델은 제외합니다. 조회 실패는 선택기에 안내하며, 저장한 선택은 유지합니다. 미설정 상태에서는 기본 선택만 보이고, 실제 목록은 API 키 설정 후 표시됩니다.

공급자마다 API 키와 선택적인 API base URL을 설정할 수 있습니다. 빈 URL은 공식 엔드포인트를 사용하며, 사용자 지정 주소는 HTTPS(로컬 개발은 HTTP loopback 허용)와 브라우저 CORS를 지원해야 합니다. 설정 저장·삭제는 진행 중 채팅을 중단하며 다음 요청부터 즉시 반영됩니다. **Forget provider**는 해당 공급자의 키·URL과 모델 캐시를 삭제합니다. 앱 예산의 상한은 컨텍스트 128,000·출력 4096 토큰이며, 모델 목록이 더 작은 한도를 제공하면 제목과 답변에도 적용합니다. 한도를 제공하지 않는 OpenAI 등은 이 앱 예산을 사용하며 실제 모델 한도를 보장하지 않습니다. 공급자 오류를 자동 재시도하지 않습니다. Stop과 연결 종료는 공급자 요청에 취소 신호를 전달합니다.

목록에 나온 모델이라고 모든 채팅 기능을 지원하는 것은 아닙니다. OpenAI는 Responses API, Anthropic은 Messages API·토큰 계산, Gemini는 generateContent·토큰 계산을 지원해야 하며 도구·검색·추론 호환성도 모델마다 다릅니다. OpenAI의 `/responses/input_tokens` 호출이 실패하면 호환 모드에서 생성 입력 JSON의 UTF-8 바이트 수로 추정해 생성을 계속합니다. 실제 토큰 수나 이미지 비용을 보장하지 않으며 입력 예산 검사·축약은 유지합니다. 웹은 공급자 서비스를 작업마다 새로 만들므로 다음 토큰 계산에서는 API 지원 여부를 다시 확인합니다. 취소·입력 검증 오류와 실제 생성 요청의 오류는 숨기지 않습니다. 이미지·음성·embedding 전용 모델 등은 현재 텍스트 채팅에 사용할 수 없습니다. 기존 대화의 모델 별칭은 계속 처리합니다.

**Request headers (optional)**에서 **Add header**로 행을 추가하고 **Key**·**Value** 입력란에 이름과 값을 입력합니다. 각 행의 삭제 버튼으로 제거하며, 행은 계속 추가할 수 있습니다. 기존에 저장한 헤더도 행으로 불러옵니다. 양쪽이 빈 행은 저장에서 제외하고, 값만 입력한 행은 거부합니다. 이름 앞뒤 공백은 제거하며 이름은 대소문자를 구분하지 않습니다. 중복 이름·잘못된 HTTP 이름·줄바꿈·비 ASCII 값은 저장 전에 거부합니다. 헤더는 기본 인증 헤더도 덮어쓸 수 있고 모델 조회·토큰 계산·제목·답변·받아쓰기 자격 증명 발급에 적용합니다. 브라우저가 금지하는 `Host`·`Cookie` 등의 헤더는 설정할 수 없으며, 사용자 지정 헤더는 엔드포인트의 CORS 허용 목록에도 있어야 합니다. 브라우저 WebSocket에는 임의 HTTP 헤더를 넣을 수 없으므로 받아쓰기 연결에는 적용하지 않습니다. **Forget provider**는 헤더도 삭제합니다.

HTTP 400 오류는 공급자 JSON의 `error.message`·문자열 `error`·`message`를 추출해 최대 1000자로 표시합니다. SDK가 JSON 문자열로 전달하는 Gemini 오류도 처리합니다. 현재 요청의 API 키·URL·헤더 값(인증 scheme을 제외한 토큰 포함)은 가리고 새 오류만 전달하며 원본 객체·응답 헤더·cause는 보존하지 않습니다. 파싱할 수 없는 응답과 다른 상태 코드는 기존 일반 안내를 유지합니다. 공급자가 일부만 노출하거나 임의로 변형한 비밀 값까지 식별할 수는 없습니다.

키·URL·헤더는 현재 origin의 `localStorage`에 **암호화 없이** 저장합니다. 같은 사이트의 스크립트나 브라우저 확장 기능이 읽을 수 있으므로 공용 브라우저에서 사용하지 마세요. 선택한 모델도 브라우저에 저장하며, 설정은 계정에 동기화하지 않습니다. 앱 서버의 환경 변수·쿠키·SSR payload에는 키·헤더를 넣지 않습니다. 브라우저가 공급자 또는 설정한 엔드포인트로 직접 키와 대화를 전송하므로 신뢰할 수 있는 주소만 사용하세요. CORS가 차단되면 오류로 알리며 서버 프록시로 우회하지 않습니다.

동일 UI를 사용하는 [데스크톱 앱](../desktop/README.md)은 LLM 설정을 localStorage 대신 OS 보안 저장소에 저장합니다. 위 브라우저 저장 안내는 웹 앱에 해당하며, 공급자 직접 요청과 CORS 정책은 데스크톱에도 적용됩니다.

## 원격 호스트 모드

웹 앱은 기본으로 브라우저에서 에이전트를 실행합니다. `apps/server`의 HTTP 호스트를 사용하려면 브라우저에 노출할 경로와 Nitro 서버가 접근할 호스트 주소를 설정합니다.

```sh
export NUXT_PUBLIC_AGENT_ENDPOINT="/api/agent"
export NUXT_AGENT_URL="http://127.0.0.1:8000"
export NUXT_AGENT_TOKEN="$KEUNDAL_API_TOKEN"
pnpm --filter @keundal/web build
pnpm --filter @keundal/web preview
```

`/api/agent/**`는 Nitro가 `NUXT_AGENT_URL`로 전달하고 `Authorization: Bearer` 헤더를 서버 측에서 붙입니다. 브라우저는 호스트 토큰을 받지 않습니다. 직접 다른 origin의 호스트를 호출하려면 `NUXT_PUBLIC_AGENT_ENDPOINT`에 전체 URL을 넣고 `NUXT_PUBLIC_AGENT_TOKEN`을 설정합니다. 이 경우 토큰이 브라우저에 노출되므로 신뢰할 수 있는 환경에서만 사용합니다. 호스트의 `KEUNDAL_CORS_ORIGINS`에 웹 앱의 origin을 추가해야 합니다.

원격 모드에서는 대화·실행·제목이 호스트의 SQLite에 저장됩니다. 모델 목록은 호스트의 `GET /models`를 사용하며, 모델 선택·API 키 설정 화면은 호스트 설정을 바꾸지 않습니다. 호스트 모델과 공급자 키는 `apps/server` 환경 변수에서 관리합니다. 데스크톱은 로컬 호스트가 준비되면 자동으로 이 모드를 사용합니다.

## 저장소와 실행 경계

- 공급자별 모델 목록 조회는 각 `plugin-llm-*` 패키지의 `listOpenAIModels`·`listAnthropicModels`·`listGeminiModels`가 담당합니다. 웹 앱은 설정 읽기, 모델 별칭, 아이콘, 캐시, 시간제한과 오류 표시를 담당합니다.
- `@keundal/core`의 `prepareReplayMessages(messages, sourceModel, targetModel)`는 결과 없는 도구 호출과 서명 없는 추론을 제외합니다. 다른 모델로 전송할 때는 추론과 어시스턴트 메타데이터·도구 서명도 제거합니다. 원본 메시지는 변경하지 않습니다. 모델 별칭 정규화는 호출자가 담당합니다.
- `shared`의 `ChatMessage`·`ChatMessageAssembly`·`ChatStore`는 앱의 표시 형식과 `session.state.web` 저장 정책을 담당합니다. 설정 저장, 첨부 파일 표시, chart/weather 예제 도구와 Nuxt 인증 타입도 앱에 둡니다.
- 브라우저의 Cordis Context에 `@keundal/plugin-store-indexeddb`와 런타임 설정을 읽는 `llm` 서비스를 등록합니다. `agentPlugin`이 입력 예산 검사·도구 실행·후속 생성을 수행하고, `session`과 `generation`이 대화·실행 journal을 IndexedDB `keundal-web`에 저장합니다.
- 기존 OpenAI·Anthropic·Gemini 플러그인이 브라우저에서 모델 한도·토큰 계산·스트림을 제공합니다. OpenAI·Anthropic SDK는 명시적인 브라우저 실행 opt-in을 사용합니다. `/api/llm` 프록시는 없으며 서버 DB, D1, R2, NuxtHub도 사용하지 않습니다. 키·URL·헤더는 생성 요청이나 journal에 넣지 않고, 400 오류의 진단 메시지만 위 규칙으로 정제해 전달합니다.
- 제목·투표·UI 메시지·첨부 이미지는 `session.state.web`에 보관합니다. 정규 AG-UI 대화는 `session.messages`에 저장합니다. 웹 앱은 저장소 내부 API나 독자적인 IndexedDB 테이블을 사용하지 않습니다.
- `ChatStore.respond()`는 HTTP나 SSE로 변환하지 않고 `AsyncIterable<AGUIEvent>`를 반환합니다. `useKeundalChat()`이 전송·중단·편집·재생성 상태를 관리하며 `ChatMessageAssembly`가 텍스트·추론·도구·출처 이벤트를 앱 소유의 `ChatMessage`로 투영합니다. `RUN_FINISHED`는 표시 메시지까지 저장한 뒤 전달합니다. 기존 `session.state.web` 메시지와 `data-keundal`의 정규 대화는 그대로 읽을 수 있습니다.
- Nuxt UI는 표시 컴포넌트로만 사용합니다. `.pnpmfile.cjs`는 Nuxt UI의 선택적 `ai` peer를 제거해 잠금 파일과 설치 그래프에 AI SDK가 다시 남지 않게 합니다.
- 이미지(파일당 최대 8MB)는 data URL로 저장하므로 새로고침 후에도 유지됩니다. 로그인은 필요하지 않습니다. PDF·CSV 등 미지원 형식은 오류로 알립니다.
- 재접속 시 `generation.recover()`가 저장된 부분 응답을 복원합니다. 미완료 실행은 `interrupted`이며 LLM 재호출·자동 재시도는 하지 않습니다. 마지막 journal 저장 이후의 조각은 유실될 수 있습니다.
- 데이터는 **현재 브라우저·origin에만** 존재합니다. 브라우저 데이터 삭제·저장소 축출 시 사라질 수 있으며 다른 기기나 로그인 계정으로 동기화되지 않습니다. 공개 링크 공유는 비활성화합니다. 기존 서버 SQLite 데이터는 자동 이전하지 않습니다.

### 저장소 교체 계약

`ChatStore`는 공개 `SessionService`·`GenerationService`만 사용합니다. 같은 실행 환경에서 저장소 플러그인 등록만 바꾸면 앱/에이전트 로직을 유지할 수 있습니다. 웹 테스트는 동일한 시나리오를 memory·IndexedDB·SQLite에 적용합니다. SQLite는 Node.js 대상이므로 브라우저에서 import하는 방식으로 교체할 수는 없으며, 서버로 배치할 때도 동일 서비스 계약을 사용해야 합니다. 서로 다른 저장소의 데이터 이전은 별도입니다.

- `session.commit()`은 기본적으로 메시지를 병합합니다. 편집·재생성처럼 뒤의 메시지를 제거할 때는 `mode: 'replace'`로 전체 배열(빈 배열 포함)을 교체합니다. revision 검사는 동일합니다.
- `session.delete(threadId, expectedRevision)`는 스레드·관련 실행·journal을 원자적으로 삭제합니다. 실행 중이면 거부하므로 호출자가 먼저 중단해야 합니다. 영구 tombstone은 남기지 않습니다.
- 신규 저장소 구현도 위 계약을 구현해야 합니다. 기존 `commit()` 호출의 병합 동작은 달라지지 않습니다.

## 스킬 관리

사이드바의 **Skills**에서 스킬을 생성·편집·삭제하거나 `SKILL.md`를 가져옵니다. 이름, 설명, Markdown 지침을 저장하고 스킬별로 사용 여부를 설정합니다. 가져온 파일은 편집 폼에서 확인한 뒤 **Save skill**로 저장합니다. 원본 파일은 변경하지 않습니다.

설정은 현재 브라우저·origin의 localStorage에 저장하며 계정이나 다른 기기로 동기화하지 않습니다. 변경 사항은 다음 응답부터 적용합니다. 실행을 시작한 응답의 목록은 유지합니다.

에이전트는 사용 중인 스킬의 이름과 설명을 확인하고 `skill` 도구로 필요한 본문을 읽습니다. 대화에는 불러온 스킬 이름과 결과를 표시합니다. 스킬은 모델 지침이며 스크립트나 첨부 파일을 자동 실행하지 않습니다. 신뢰할 수 있는 지침만 추가합니다.

데스크톱 앱은 같은 관리 화면에서 [로컬 `.agents/skills` 파일](../desktop/README.md#로컬-스킬)도 읽습니다.

## 검색·추론·받아쓰기

- Web search는 OpenAI/Anthropic 내장 검색을 사용하고 URL 출처·후속 요청용 검색 블록을 보존합니다. 원본 템플릿과 마찬가지로 Gemini에서는 함수 도구와 검색을 함께 등록하지 않습니다.
- Extended thinking은 Keundal `reasoning` 옵션으로 전달합니다. 켜면 OpenAI medium·Anthropic thinking 예산·Gemini 3 high를 사용합니다. 끄면 Anthropic disabled·GPT-5 Nano minimal(검색 시 low)·Gemini 3 Flash minimal이며, 후자의 두 모델은 추론을 완전히 끌 수 없습니다.
- 서명된 추론·검색 블록은 다음 턴에도 유지하고 다른 모델로 전환하면 공급자 전용 상태를 제거합니다. chart/weather 도구를 지원하며 weather는 원본 템플릿의 데모 데이터입니다.
- 받아쓰기는 브라우저의 OpenAI 설정과 `@keundal/plugin-transcription-openai`로 단기 자격 증명을 직접 발급하고 PCM16 24kHz를 스트리밍합니다. 로그인은 필요하지 않으며 모델은 `gpt-4o-mini-transcribe`입니다. 사용자 지정 OpenAI 주소는 Realtime REST·WebSocket도 지원해야 합니다.
- 로컬 공급자 fixture로 프로토콜과 취소·도구 후속 요청을 검증합니다. 실제 유료 API의 모델 접근 권한·검색 결과·음성 인식 품질은 별도 확인이 필요합니다.

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

기존 `versions upload --preview-alias`로 만든 URL은 개별 삭제할 수 없습니다. `preview_urls: false` 설정이 다음 `main` 운영 배포에 반영되면 구형 버전 URL·별칭을 모두 비활성화합니다. 새 `preview` 방식의 URL은 이 설정과 독립적이며 PR 종료 시 개별 삭제합니다. 운영 Worker 자체와 정상 운영 URL은 삭제하지 않습니다.

배포 자격 증명을 보호하기 위해 포크 PR은 자동 배포하지 않습니다. `pull_request_target`으로 PR 코드를 실행하지 않으며, 같은 저장소의 PR 코드는 배포 권한을 가진 신뢰된 코드로 취급합니다. CI 검사가 실패하거나 문서 전용 PR처럼 검사가 생략되면 배포하지 않습니다. GitHub는 생략된 job을 필수 검사 실패로 취급하지 않으므로 포크·문서 전용 PR에 프리뷰 성공을 강제하지는 않습니다.

LLM 공급자 키는 Worker에 등록하지 않고 각 사용자가 웹 설정에서 입력합니다.

공개 앱도 사용자 자신의 키로 직접 요청합니다. 공급자의 비용·권한·브라우저 접근 정책은 해당 키 소유자가 관리해야 합니다.

## 검증

```sh
pnpm build
pnpm --filter @keundal/web test
pnpm --filter @keundal/web typecheck
pnpm --filter @keundal/web lint
```

웹 테스트는 빌드한 Node.js 프로덕션 서버를 실행하여 홈·대화 경로의 HTTP 200 응답도 확인합니다. 루트 `pnpm test`는 필요한 빌드를 먼저 실행합니다. Zod는 pnpm 저장소의 locale 파일 경로가 런타임 외부 참조로 남지 않도록 Nitro에 번들링합니다.

원본 UI의 ESLint 설정을 사용하며 루트 Oxfmt로 웹 소스를 재포맷하지 않습니다.
