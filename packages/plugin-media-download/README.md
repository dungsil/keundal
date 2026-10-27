# @keundal/plugin-media-download

`@keundal/media`의 다운로드 계약을 `yt-dlp`로 구현합니다. 링크를 큐에 넣으면 작업이 백그라운드에서 진행되고, 상태 변화를 구독자에게 전달합니다.

## 설정

```ts
import localMediaDownloadPlugin from '@keundal/plugin-media-download'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(localMediaDownloadPlugin, { workDirectory: '/data/keundal/work' })
```

이 플러그인은 `ctx.shell`과 `ctx.mediaTools`를 주입받습니다. `workDirectory`는 진행 로그를 남기는 곳이고, 생략하면 시스템 임시 디렉터리를 씁니다.

## 사용

```ts
const job = await ctx.mediaDownload.start({
  url: 'https://example.com/watch?v=1',
  outputDirectory: '/library/inbox',
  format: '1080p',
  subtitles: 'builtin',
  cookiesFromBrowser: 'chrome'
})
const finished = await ctx.mediaDownload.wait(job.jobId)
console.log(finished.state, finished.filePath)
```

## 작업 제어

| 메서드      | 동작                                                        |
| ----------- | ----------------------------------------------------------- |
| `start`     | 작업을 큐에 넣고 즉시 반환합니다.                           |
| `pause`     | 실행 중인 프로세스를 중단하고 `paused`로 바꿉니다.          |
| `resume`    | 중단한 작업을 다시 실행합니다. `--continue`로 이어받습니다. |
| `cancel`    | 작업을 끝내고 `cancelled`로 바꿉니다.                       |
| `wait`      | 작업이 끝나거나 실패할 때까지 기다립니다.                   |
| `subscribe` | 상태 변화를 받습니다. `replay`를 켜면 기존 작업도 받습니다. |

## 진행률

`yt-dlp`의 출력은 `workDirectory` 아래 임시 폴더의 로그 파일로 보냅니다. 이 플러그인은 로그를 `pollMs` 주기로 읽어서 퍼센트, 내려받은 크기, 전체 크기, 속도, 남은 시간을 계산합니다.

`format`은 다음 값을 받습니다.

| 값      | 인자                                     |
| ------- | ---------------------------------------- |
| `best`  | `bv*+ba/b`                               |
| `1080p` | `bv*[height<=1080]+ba/b[height<=1080]/b` |
| `720p`  | `bv*[height<=720]+ba/b[height<=720]/b`   |
| `audio` | `bestaudio/best`와 음원 추출, `m4a` 저장 |

## 한계

`ctx.shell`은 실행이 끝난 뒤에 결과를 돌려주므로, 이 플러그인은 프로세스 출력을 실시간으로 받지 못합니다. 진행률은 로그 파일을 다시 읽어서 갱신합니다.

저장 경로는 `yt-dlp`가 마지막에 출력하는 파일 경로를 그대로 씁니다. 실패한 작업의 메시지는 표준 오류의 마지막 줄입니다.
