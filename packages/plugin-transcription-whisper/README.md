# @keundal/plugin-transcription-whisper

`@keundal/transcription`의 `MediaTranscriptionService`를 `whisper.cpp`로 구현합니다. 저장된 영상 파일의 소리를 뽑아 자막과 단어 시각을 만듭니다.

## 요구 사항

`whisper.cpp` 실행 파일이 필요합니다. 기본 이름은 `whisper-cli`이고 `PATH`에서 찾습니다. 다른 경로를 쓰려면 `executable`에 절대 경로를 넘깁니다.

오디오 추출은 `ffmpeg`가 맡습니다. 이 플러그인은 `ctx.shell`과 `ctx.mediaTools`를 주입받습니다.

## 설정

```ts
import whisperTranscriptionPlugin from '@keundal/plugin-transcription-whisper'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(whisperTranscriptionPlugin, {
  dataDir: '/data/keundal',
  threads: 4
})
```

`dataDir` 아래 `models` 폴더에 모델 파일을 저장합니다. `workDirectory`는 오디오 임시 파일을 두는 곳이고, 생략하면 시스템 임시 디렉터리를 씁니다.

## 모델

| ID                    | 크기     | 설명                 |
| --------------------- | -------- | -------------------- |
| `tiny`                | 약 78MB  | 빠른 시험용          |
| `small`               | 약 488MB | 일상 사용            |
| `medium`              | 약 1.5GB | 정확도 우선          |
| `large-v3`            | 약 3.1GB | 가장 정확하지만 느림 |
| `large-v3-turbo-q5_0` | 약 574MB | 기본값, 압축 모델    |

모델 파일은 Hugging Face의 `ggerganov/whisper.cpp` 저장소에서 내려받습니다.

```ts
const models = await ctx.mediaTranscription.models()
await ctx.mediaTranscription.installModel(
  { id: 'large-v3-turbo-q5_0' },
  { onProgress: (progress) => console.log(progress.downloadedBytes) }
)
```

## 전사

```ts
const result = await ctx.mediaTranscription.transcribe({
  filePath: '/libraries/one/clip.mp4',
  language: 'ko'
})
console.log(result.words)
```

`language`를 비우면 모델이 언어를 감지합니다. 결과의 `segments`는 인식기가 돌려준 구간을 그대로 담고, `words`는 토큰 단위 시각입니다. 특수 토큰과 길이가 0인 구간은 `words`에서 뺍니다.

## 자막 줄 나누기

`buildSegments(words, options)`는 단어 시각을 자막 줄로 묶습니다. 침묵, 문장 부호, 글자 수, 길이 한도에서 줄을 나눕니다.

```ts
import { buildSegments } from '@keundal/plugin-transcription-whisper'

const lines = buildSegments(result.words, { maxCharacters: 42, gapMs: 600, maxDurationMs: 7_000 })
```

## 한계

`ctx.shell`이 실행이 끝난 뒤에 결과를 돌려주므로 전사 중간 진행률은 제공하지 않습니다. 요청을 취소하면 실행 중인 프로세스를 중단합니다.

화자 분리는 아직 없습니다. `segments`와 `words`에 화자 정보가 들어 있지 않습니다.
