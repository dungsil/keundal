# Nuxt AI Chatbot Template

[![Nuxt UI](https://img.shields.io/badge/Made%20with-Nuxt%20UI-00DC82?logo=nuxt&labelColor=020420)](https://ui.nuxt.com)

Full-featured AI Chatbot Nuxt application with authentication, chat history, collapsible sidebar, keyboard shortcuts, light & dark mode, command palette and more. Built using [Nuxt UI](https://ui.nuxt.com) components and integrated with [AI SDK](https://ai-sdk.dev) for a complete chat experience.

- [Live demo](https://chat-template.nuxt.dev/)
- [Documentation](https://ui.nuxt.com/docs/getting-started/installation/nuxt)

<a href="https://chat-template.nuxt.dev/" target="_blank">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://ui.nuxt.com/assets/templates/nuxt/chat-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://ui.nuxt.com/assets/templates/nuxt/chat-light.png">
    <img alt="Nuxt AI Chatbot Template" src="https://ui.nuxt.com/assets/templates/nuxt/chat-light.png">
  </picture>
</a>

> The chat template for Vue is on https://github.com/nuxt-ui-templates/chat-vue.

## Features

- ⚡️ **Streaming AI messages** powered by Keundal with the original AI SDK client transport and thinking/reasoning support
- 🤖 **Multiple model support** — Claude Haiku 4.5, Gemini 3 Flash and GPT-5 Nano through the existing Keundal LLM plugins
- 🔍 **Web search and extended thinking** through Keundal provider options; see provider-specific limitations below
- 🎤 **Dictation** in the prompt with live streaming transcription over WebSocket through `@keundal/plugin-transcription-openai`
- 📊 **Charts and weather** tool calling with rich UI rendering
- 🔐 **Authentication** via GitHub OAuth using [nuxt-auth-utils](https://github.com/atinux/nuxt-auth-utils)
- 💾 **Chat history persistence** using SQLite database ([Turso](https://turso.tech) in production) and [Drizzle ORM](https://orm.drizzle.team)
- 📎 **File uploads** with drag & drop using [NuxtHub Blob](https://hub.nuxt.com/docs/blob) (requires authentication)
- ✨ **Markdown rendering** with streaming code highlighting via [Comark](https://comark.dev)

## Quick Start

```bash
npm create nuxt@latest -- -t ui/chat
```

## Deploy your own

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fnuxt-ui-templates%2Fchat&repository-name=chat&env=NUXT_OAUTH_GITHUB_CLIENT_ID%2CNUXT_OAUTH_GITHUB_CLIENT_SECRET%2CNUXT_SESSION_PASSWORD&stores=%5B%7B%22type%22%3A%22integration%22%2C%22integrationSlug%22%3A%22tursocloud%22%2C%22productSlug%22%3A%22database%22%2C%22protocol%22%3A%22storage%22%7D%2C%7B%22type%22%3A%22blob%22%7D%5D&demo-title=Nuxt+Chat+Template&demo-description=An+AI+chatbot+template+with+GitHub+authentication+and+persistent+chat+history+powered+by+Vercel+AI+SDK.&demo-url=https%3A%2F%2Fchat-template.nuxt.dev&demo-image=https%3A%2F%2Fui.nuxt.com%2Fassets%2Ftemplates%2Fnuxt%2Fchat-dark.png)

## Setup

Make sure to install the dependencies:

```bash
pnpm install
```

Run database migrations:

```bash
pnpm db:migrate
```

> [!NOTE]
> In production, configure your database connection. On Vercel, add the [Turso integration](https://vercel.com/integrations/turso) to automatically provision `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`.

### AI Integration

Nuxt UI Chat 원본의 화면·컴포넌트·스타일을 유지합니다. 제목 생성은 Keundal LLM 플러그인, 대화·입력 예산 검사·chart/weather 실행·후속 요청은 `@keundal/plugin-agent-simple`과 메모리 저장소로 실행합니다. 서버는 AG-UI 이벤트를 원본 클라이언트의 UIMessage SSE 규격으로 전달하며 AI SDK 생성·도구 실행 API와 AI Gateway를 사용하지 않습니다. `@ai-sdk/vue`, `DefaultChatTransport`, UIMessage 타입은 템플릿 클라이언트 호환용으로 남아 있습니다. Nuxt 서버에서 플러그인을 직접 조합하므로 `apps/server`를 별도로 실행하지 않아도 됩니다.

선택한 모델의 API 키를 `apps/web/.env`에 설정합니다. 제목도 선택한 모델로 생성하므로 Gemini나 Anthropic만 사용할 때 OpenAI 키는 필요하지 않습니다.

| 화면의 모델 | Keundal에 전달하는 모델 ID | 환경 변수 |
| --- | --- | --- |
| Claude Haiku 4.5 | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| Gemini 3 Flash | `gemini-3-flash-preview` | `GEMINI_API_KEY` |
| GPT-5 Nano | `gpt-5-nano` | `OPENAI_API_KEY` |

필요하면 `OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `ANTHROPIC_BASE_URL`로 공급자 API 주소를 지정할 수 있습니다. 출력 예산은 4096 토큰이며, 공급자의 오류를 자동 재시도하지 않습니다. 연결 종료와 Stop 요청은 진행 중인 공급자 요청에 전달합니다.

**검색·추론·받아쓰기와 저장:**

- Web search 스위치는 OpenAI/Anthropic의 공급자 내장 검색을 활성화합니다. URL 출처와 후속 요청에 필요한 검색 블록을 보존합니다. 원본 템플릿과 마찬가지로 Gemini에는 함수 도구와 함께 검색을 등록하지 않습니다.
- Extended thinking 스위치는 Keundal의 `reasoning` 옵션으로 전달합니다. 켜면 OpenAI medium, Anthropic 명시적 thinking 예산, Gemini 3 high를 사용합니다. 끄면 Anthropic은 disabled, GPT-5 Nano는 minimal(검색 시 low), Gemini 3 Flash는 minimal을 사용하고 요약을 요청하지 않습니다. 후자의 두 모델은 추론을 완전히 끌 수 없습니다. 암호화된 추론·thought 서명과 검색 블록은 저장 후 다음 턴에도 유지하며 다른 모델로 전환할 때 공급자 전용 상태를 제거합니다.
- 텍스트·이미지 입력과 chart/weather 도구를 지원합니다. PDF 등 Keundal이 지원하지 않는 첨부 형식은 명시적인 오류로 처리합니다. 원본 weather 도구는 실시간 날씨 API가 아닌 데모 데이터를 반환합니다.
- 받아쓰기는 `@keundal/plugin-transcription-openai`로 OpenAI 단기 자격 증명을 발급하고 브라우저에서 PCM16 24kHz를 직접 스트리밍합니다. `OPENAI_API_KEY`와 로그인이 필요하며 `AI_GATEWAY_API_KEY`는 필요하지 않습니다. 전사 모델은 `gpt-4o-mini-transcribe`입니다.
- Keundal session/generation 메모리 저장소는 요청 수명 동안 도구 실행 전체를 기록합니다. 요청 사이의 대화·도구 결과·공급자 상태는 원본 NuxtHub SQLite의 메시지 parts에 보존합니다. 서버 재시작 시 미완료 실행을 복구하는 내구성 generation 저장소로 구성한 것은 아닙니다.
- 로컬 HTTP/WebSocket fixture로 공급자 프로토콜, 원본 클라이언트의 SSE 해석, 도구 후속 실행, 저장 후 재생, 취소·오류·전사 정리를 검증합니다. 실제 유료 API의 모델 접근 권한·검색 결과·음성 인식 품질은 별도 확인이 필요합니다.

### Authentication (Optional)

This template uses [nuxt-auth-utils](https://github.com/atinux/nuxt-auth-utils) for authentication with GitHub OAuth.

To enable authentication, [create a GitHub OAuth application](https://github.com/settings/applications/new) and set:

```bash
NUXT_OAUTH_GITHUB_CLIENT_ID=<your-github-oauth-app-client-id>
NUXT_OAUTH_GITHUB_CLIENT_SECRET=<your-github-oauth-app-client-secret>
NUXT_SESSION_PASSWORD=<your-password-minimum-32-characters>
```

### Blob Storage (Optional)

This template uses [NuxtHub Blob](https://hub.nuxt.com/docs/blob) for file uploads, which supports multiple storage drivers:

- **Local filesystem** (default for development, stored in `.data/blob`)
- **[Vercel Blob](https://vercel.com/docs/vercel-blob)** (auto-configured when deployed to Vercel)
- **[Cloudflare R2](https://hub.nuxt.com/docs/blob#set-a-driver)** (when deployed to Cloudflare)
- **[Amazon S3](https://hub.nuxt.com/docs/blob#set-a-driver)** (with manual configuration)

For **Vercel Blob**, assign a Blob Store to your project from the Vercel dashboard (Project → Storage), then set the token for local development:

```bash
BLOB_READ_WRITE_TOKEN=<your-vercel-blob-token>
```

> [!NOTE]
> File uploads require authentication. See the [NuxtHub Blob documentation](https://hub.nuxt.com/docs/blob#set-a-driver) for configuring other storage drivers.

## Development Server

Start the development server on `http://localhost:3000`:

```bash
pnpm dev
```

## Production

Build the application for production:

```bash
pnpm build
```

Locally preview production build:

```bash
pnpm preview
```

Check out the [deployment documentation](https://nuxt.com/docs/getting-started/deployment) for more information.

### Cloudflare Workers

Workers의 module preset과 D1·R2를 사용합니다. 아래 명령은 저장소 루트에서 실행합니다.

```bash
pnpm --filter @keundal/web exec wrangler login
pnpm --filter @keundal/web exec wrangler d1 create keundal-web
pnpm --filter @keundal/web exec wrangler r2 bucket create keundal-web-blobs
```

반환된 D1 ID와 R2 버킷 이름을 `apps/web/.env`의 `CLOUDFLARE_D1_DATABASE_ID`, `CLOUDFLARE_R2_BUCKET_NAME`에 설정합니다. API 토큰 방식이면 셸/CI의 비밀 환경 변수에 `CLOUDFLARE_API_TOKEN`과 계정 선택용 `CLOUDFLARE_ACCOUNT_ID`를 설정하며 저장소에 커밋하지 않습니다. Worker 이름은 `keundal-web`입니다. 기존 서비스가 있다면 덮어쓰기 전에 계정과 이름을 확인하세요.

```bash
pnpm build
pnpm --filter @keundal/web build:cloudflare
pnpm --filter @keundal/web db:migrate:cloudflare
pnpm --filter @keundal/web deploy:cloudflare
```

NuxtHub가 `.output/server/wrangler.json`에 D1 `DB`·R2 `BLOB` 바인딩과 마이그레이션 경로를 생성합니다. `db:migrate:cloudflare`는 **원격 D1을 변경**합니다. 기존 운영 DB에는 먼저 백업과 마이그레이션 검토가 필요합니다. `wrangler deploy`는 마이그레이션을 자동 실행하지 않습니다. 로컬 SQLite 데이터는 자동 이전되지 않습니다.

런타임 비밀 값은 로컬 `.env`와 별개입니다. 다음 명령의 비공개 프롬프트에서 `NUXT_SESSION_PASSWORD`(32자 이상)와 사용할 공급자의 키를 등록합니다. OAuth와 받아쓰기를 쓰려면 앞 절의 해당 키도 등록해야 합니다.

```bash
pnpm --filter @keundal/web exec wrangler secret put NUXT_SESSION_PASSWORD --config .output/server/wrangler.json
pnpm --filter @keundal/web exec wrangler secret put OPENAI_API_KEY --config .output/server/wrangler.json
```

GitHub OAuth callback URL은 배포된 도메인의 `/auth/github`로 지정합니다. 원본 템플릿은 비로그인 대화도 허용하므로 공개 서비스에 공급자 키를 등록하기 전에 Cloudflare Access 등으로 접근과 비용을 통제하세요. D1/R2 사용은 계정의 요금제에 따라 비용이 발생할 수 있습니다.

## Renovate integration

Install [Renovate GitHub app](https://github.com/apps/renovate/installations/select_target) on your repository and you are good to go.
