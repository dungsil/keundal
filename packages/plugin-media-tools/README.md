# @keundal/plugin-media-tools

`@keundal/media`의 도구 계약을 로컬 환경에서 구현합니다. `yt-dlp`와 `ffmpeg`의 경로를 찾고, 버전을 확인하고, 실행 파일을 내려받습니다.

## 설정

```ts
import localMediaToolsPlugin from '@keundal/plugin-media-tools'
import localShellPlugin from '@keundal/plugin-shell-local'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(localShellPlugin, { cwd: process.cwd() })
await ctx.plugin(localMediaToolsPlugin, { dataDir: '/data/keundal' })
```

이 플러그인은 `ctx.shell`을 주입받습니다.

## 탐색 순서

1. `configure`로 지정한 경로
2. `dataDir/tools`에 설치한 실행 파일
3. `PATH`에 있는 실행 파일

`PATH` 검색은 `command -v`와 `where`를 `ctx.shell`로 실행해서 처리합니다.

## 설치

```ts
const status = await ctx.mediaTools.install(
  { name: 'yt-dlp' },
  { onProgress: (progress) => console.log(progress.downloadedBytes) }
)
```

설치는 바이트 배열 하나를 내려받아 `dataDir/tools`에 저장하고 실행 권한을 줍니다. 압축 파일은 풀지 않습니다.

기본 내려받기 주소는 `yt-dlp`에만 있습니다. `ffmpeg`는 배포 경로가 플랫폼마다 달라서 기본 주소를 두지 않았습니다. 압축 파일만 제공하는 도구는 `sources` 설정에 실행 파일 주소를 넘겨야 합니다.

```ts
await ctx.plugin(localMediaToolsPlugin, {
  dataDir: '/data/keundal',
  sources: { ffmpeg: 'https://example.com/ffmpeg-linux-x64' }
})
```

## 검증

`fetch`를 설정으로 바꿀 수 있습니다. 테스트는 이 자리에 가짜 함수를 넣어서 네트워크 없이 설치를 확인합니다. `lookupCommands`도 같은 목적으로 바꿀 수 있습니다.
