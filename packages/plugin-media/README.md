# @keundal/plugin-media

영상 자료실, 다운로드, whisper.cpp 전사, LLM 자막 번역과 ffmpeg·FCPXML 내보내기를 조립하는 Cordis 선택 기능입니다. [#296](https://github.com/dungsil/keundal/pull/296)의 기능을 호스트에 직접 넣지 않고 플러그인의 수명 안에서 제공합니다.

## Desktop

**설정 → 큰달 플러그인 → 미디어 자료실**을 켭니다. 기본값은 비활성입니다. sidecar를 다시 시작한 뒤 자료실 탐색 항목과 미디어 설정이 나타납니다. 비활성화해도 자료실과 내려받은 실행 파일·모델은 지우지 않습니다. 기존 선택 파일에 미디어 항목이 없으면 비활성으로 추가하며 다른 선택과 외부 설치는 보존합니다.

## Node.js 호스트

`keundal.plugins.json`의 `plugins`에 등록합니다. 별도의 미디어 환경 변수는 없습니다. 외부 패키지로 사용할 때는 해당 패키지와 의존성을 먼저 설치하고 JavaScript로 빌드합니다.

```json
{
  "plugins": [
    { "module": "builtin:llm" },
    { "module": "builtin:store" },
    {
      "module": "@keundal/plugin-media",
      "config": { "dataDir": "/data/media", "libraryRoot": "/data/libraries" }
    }
  ],
  "agent": { "module": "builtin:agent" }
}
```

직접 조립할 때는 `createAgentHost()`의 `setup(ctx)`에서 `await ctx.plugin(media, config)`를 호출합니다. `hostHttp`와 `llm`이 필요합니다. 호스트가 `hostHttp`를 제공하고 앱이 LLM을 선택합니다. 기본 `dataDir`은 `~/.keundal/media`이며 desktop은 앱이 관리하는 플러그인 디렉터리 아래 `media`를 사용합니다. `libraryRoot`를 생략하면 인증된 호출자가 자료실 경로를 선택할 수 있습니다. 이 기능은 신뢰하는 사용자에게만 노출해야 합니다.

플러그인은 에이전트의 셸과 격리된 `ctx.shell`을 사용합니다. 하위 구현은 `plugin-library-fs`, `plugin-media-tools`, `plugin-media-download`, `plugin-transcription-whisper`, `plugin-subtitle-translate`, `plugin-media-export`입니다. 계약은 `@keundal/media`와 `@keundal/transcription`에 둡니다. 직접 조립한 서비스를 HTTP로 열 때는 `@keundal/plugin-media/http`의 `mediaHttpPlugin`을 등록할 수 있습니다.

## HTTP와 화면

플러그인은 `ctx.hostHttp`에 `/media`를 등록합니다. 공통 호스트와 Node.js 기본 조립에는 미디어 서비스나 미디어 경로를 넣지 않습니다. 해제하면 경로를 회수하고 진행 중인 요청과 작업을 취소합니다. 플러그인이 없을 때 `/media/*`는 `404`입니다.

- `GET /media/status`: 사용 가능 여부
- `/media/libraries`, `/media/libraries/open`, `/media/libraries/items`, `/media/libraries/import`: 자료실 관리
- `/media/items`, `/media/items/subtitles`: 항목 조회·삭제와 자막 저장
- `/media/tools`, `/media/tools/:name`, `/media/tools/:name/install`: 실행 파일 관리
- `/media/downloads`, `/media/downloads/events`, `/media/downloads/:id/:action`: 다운로드와 진행 상태
- `/media/transcription/models`, `/media/transcription/models/:id/install`, `/media/transcriptions`: 로컬 전사
- `/media/subtitles/translate`, `/media/exports/clips`, `/media/exports/fcpxml`: 번역과 내보내기

모든 API는 호스트의 Bearer 인증, CORS와 본문 크기 제한을 유지합니다. 재생은 인증된 `POST /media/video-access`에 `{ libraryPath, itemId }`를 보내 받은 `ticket`을 `GET /media/video`에 전달합니다. 티켓은 발급한 자료실·항목의 읽기에만 유효하며 1시간 뒤 만료됩니다. 플러그인을 다시 등록하면 이전 티켓을 사용할 수 없습니다. 전체 API 토큰은 재생 URL에 넣지 않습니다. 비디오 응답은 Range 요청을 지원합니다.

`@keundal/chat/media`의 HTTP 클라이언트와 `@keundal/ui-media`가 화면을 제공합니다. web 로컬 실행에서는 사용할 수 없으며, 원격 호스트에 연결하면 사용 가능 여부를 확인합니다. 로컬 도구와 파일 경로는 브라우저가 아니라 연결한 호스트의 것을 사용합니다.

## 실행 도구

`yt-dlp`, `ffmpeg`, `whisper-cli`는 별도의 실행 파일입니다. 설정 화면에서 지원하는 도구·모델을 설치하거나 구현 설정으로 경로를 지정합니다. whisper.cpp 실행 파일은 직접 준비해야 합니다. 자동으로 외부 실행 파일을 내려받거나 전사를 시작하지 않습니다. 실제 실행·설치와 지원 플랫폼의 세부 사항은 각 하위 패키지 문서를 참고합니다.
