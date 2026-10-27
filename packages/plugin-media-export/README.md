# @keundal/plugin-media-export

`@keundal/media`의 `MediaExportService`를 `ffmpeg`로 구현합니다. 자막 구간이나 직접 넣은 시각으로 클립을 만들고, 편집기에서 이어서 쓸 FCPXML을 씁니다.

## 설정

```ts
import localMediaExportPlugin from '@keundal/plugin-media-export'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(localMediaExportPlugin, { workDirectory: '/data/keundal/work' })
```

이 플러그인은 `ctx.shell`, `ctx.mediaTools`, `ctx.media`를 주입받습니다. `workDirectory`는 자막 파일 같은 임시 파일을 두는 곳이고, 생략하면 시스템 임시 디렉터리를 씁니다.

## 클립 만들기

```ts
const files = await ctx.mediaExport.clips({
  libraryPath: '/libraries/one',
  itemId: 'item-1',
  outputDirectory: '/exports',
  clips: [
    { id: 'c1', name: '첫 장면', startMs: 12_000, endMs: 21_500 },
    { id: 'c2', name: '둘째 장면', startMs: 40_000, endMs: 47_000 }
  ],
  burnSubtitles: true,
  trackId: 'original',
  watermark: 'keundal'
})
```

클립마다 `ffmpeg`를 실행하고 `libx264`와 `aac`로 다시 인코딩합니다. 결과 파일 이름은 클립 이름을 따르고, 같은 이름이 겹치면 번호를 붙입니다.

`burnSubtitles`를 켜면 `trackId` 트랙을 ASS로 만들고 `subtitles` 필터로 굽습니다. 자막 시각은 클립 시작을 0으로 옮겨 계산합니다. `watermark`는 `drawtext` 필터로 넣습니다.

## FCPXML

```ts
const written = await ctx.mediaExport.fcpxml({
  libraryPath: '/libraries/one',
  itemId: 'item-1',
  outputPath: '/exports/clips.fcpxml',
  clips
})
```

FCPXML 1.9 문서 하나를 씁니다. 원본 파일은 `file:` 주소로 가리키고, 클립은 시작 시각과 길이만 다른 `asset-clip`으로 들어갑니다. 원본 파일은 옮기지 않습니다.

## 한계

클립 하나가 끝날 때까지 진행률을 알리지 않습니다. `ShellService`가 실행 종료 뒤에 결과를 돌려주기 때문입니다.

번인에는 `ffmpeg`의 `libass` 지원이, 워터마크에는 `libfreetype` 지원이 필요합니다. 두 기능이 없는 빌드에서는 `ffmpeg`가 오류를 돌려주고, 그 마지막 줄이 예외 메시지가 됩니다.

FCPXML은 영상과 클립 구간만 담습니다. 오디오 채널 설정과 자막 트랙은 넣지 않습니다.
