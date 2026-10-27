# @keundal/media

미디어 자료库의 서비스 계약을 제공합니다. 이 패키지는 타입과 추상 클래스만 담고, 파일 시스템 접근과 프로세스 실행은 구현 플러그인이 맡습니다.

## 서비스

| 서비스                    | 역할                                                   |
| ------------------------- | ------------------------------------------------------ |
| `ctx.media`               | 자료库 폴더와 그 안의 항목을 읽고 씁니다.              |
| `ctx.mediaTools`          | `yt-dlp`와 `ffmpeg`의 경로, 버전, 설치를 관리합니다.   |
| `ctx.mediaDownload`       | 링크 하나를 영상 파일로 내려받는 작업 큐를 제공합니다. |
| `ctx.subtitleTranslation` | 자막 트랙을 배치로 번역합니다.                         |
| `ctx.mediaExport`         | 클립을 만들고 FCPXML로 내보냅니다.                     |

## 저장 형식

자료库는 호출자가 정한 폴더이고, 항목 하나가 폴더 하나입니다. 항목 폴더의 `item.json`이 제목, 출처, 저장 방식, 자막 트랙을 담습니다. 자료库 루트의 `library.json`은 형식 버전과 자료库 이름을 담습니다.

복사 항목은 영상 파일을 항목 폴더 안에 두므로 원본을 지워도 재생할 수 있습니다. 연결 항목은 원본 절대 경로를 기억하고, 원본이 사라지면 `video.present`가 `false`가 됩니다.

## 사용

```ts
import fsMediaLibraryPlugin from '@keundal/plugin-library-fs'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(fsMediaLibraryPlugin, { root: '/data/media' })

const library = await ctx.media.create({ path: '/data/media/library' })
const items = await ctx.media.import({
  libraryPath: library.path,
  entries: [{ filePath: '/downloads/clip.mp4', storage: 'copy' }]
})
```

## 구현 플러그인

| 패키지                               | 역할                                     |
| ------------------------------------ | ---------------------------------------- |
| `@keundal/plugin-library-fs`         | 자료库를 파일 시스템에 저장합니다.       |
| `@keundal/plugin-media-tools`        | `yt-dlp`와 `ffmpeg`를 찾고 내려받습니다. |
| `@keundal/plugin-media-download`     | `yt-dlp`로 다운로드 작업을 실행합니다.   |
| `@keundal/plugin-subtitle-translate` | `llm`으로 자막을 배치 번역합니다.        |
| `@keundal/plugin-media-export`       | `ffmpeg`로 클립과 FCPXML을 만듭니다.     |

## 한계

`mediaDownload`의 진행률은 `yt-dlp`가 남긴 로그를 정해진 주기로 읽어 계산합니다. 진행률 갱신 주기는 `pollMs` 설정을 따르고, 기본값은 500밀리초입니다.

`plugin-media-tools`는 실행 파일 하나를 내려받아 설치합니다. 압축 파일 배포본은 풀지 않으므로, 압축 파일만 제공하는 도구는 `sources` 설정에 실행 파일 주소를 지정해야 합니다.
