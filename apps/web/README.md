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

- ⚡️ **Streaming AI messages** powered by the [AI SDK](https://ai-sdk.dev) with thinking/reasoning support
- 🤖 **Multiple model support** — Claude Haiku 4.5, Gemini 3 Flash and GPT-5 Nano through the existing Keundal LLM plugins
- 🔍 Original web search and extended thinking controls are preserved visually; see the limitations below
- 🎤 **Dictation** in the prompt with live streaming transcription over WebSocket through [AI Gateway](https://vercel.com/docs/ai-gateway)
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

화면과 클라이언트 코드는 Nuxt UI Chat 원본을 유지합니다. 서버의 제목 생성과 대화 요청은 `@keundal/plugin-llm-openai`, `@keundal/plugin-llm-gemini`, `@keundal/plugin-llm-anthropic`으로 실행합니다. AI SDK는 UI 메시지 스트림 변환과 chart/weather 도구 실행 및 후속 요청만 담당하며, 텍스트 생성에 AI Gateway를 사용하지 않습니다. Nuxt 서버에서 플러그인을 직접 조합하므로 `apps/server`를 별도로 실행하지 않아도 됩니다.

선택한 모델의 API 키를 `apps/web/.env`에 설정합니다. 제목도 선택한 모델로 생성하므로 Gemini나 Anthropic만 사용할 때 OpenAI 키는 필요하지 않습니다.

| 화면의 모델 | Keundal에 전달하는 모델 ID | 환경 변수 |
| --- | --- | --- |
| Claude Haiku 4.5 | `claude-haiku-4-5` | `ANTHROPIC_API_KEY` |
| Gemini 3 Flash | `gemini-3-flash-preview` | `GEMINI_API_KEY` |
| GPT-5 Nano | `gpt-5-nano` | `OPENAI_API_KEY` |

필요하면 `OPENAI_BASE_URL`, `GEMINI_BASE_URL`, `ANTHROPIC_BASE_URL`로 공급자 API 주소를 지정할 수 있습니다. 출력 예산은 4096 토큰이며, 공급자의 오류를 자동 재시도하지 않습니다. 연결 종료와 Stop 요청은 진행 중인 공급자 요청에 전달합니다.

**현재 제한:**

- Keundal 계약에는 공급자 내장 웹 검색이 없어, 원본 Web search 스위치는 실제 검색을 활성화하지 않습니다. 모델에는 검색 도구가 없음을 안내합니다.
- Extended thinking 스위치는 UI에 추론을 표시할지만 제어하며, 추론 활성화·강도는 기존 Keundal 공급자 구현의 기본 동작을 따릅니다.
- 텍스트·이미지 입력과 chart/weather 도구를 지원합니다. PDF 등 Keundal이 지원하지 않는 첨부 형식은 명시적인 오류로 처리합니다. 원본 weather 도구는 실시간 날씨 API가 아닌 데모 데이터를 반환합니다.
- 음성 받아쓰기는 LLM 플러그인의 범위 밖이므로 기존 AI Gateway 경로를 유지하며, 이 기능에만 `AI_GATEWAY_API_KEY`와 로그인이 필요합니다.
- 대화 저장은 원본 NuxtHub SQLite를 유지합니다. Keundal의 session/generation 저장소나 복구 API로 교체하는 변경은 포함하지 않습니다.

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

## Renovate integration

Install [Renovate GitHub app](https://github.com/apps/renovate/installations/select_target) on your repository and you are good to go.
