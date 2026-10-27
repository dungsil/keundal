# @keundal/plugin-library-fs

`@keundal/media`의 자료库 계약을 파일 시스템으로 구현합니다.

## 설정

```ts
import fsMediaLibraryPlugin from '@keundal/plugin-library-fs'
import { Context } from 'cordis'

const ctx = new Context()
await ctx.plugin(fsMediaLibraryPlugin, { root: '/data/media' })
```

`root`를 지정하면 자료库 경로가 그 디렉터리 안에 있어야 합니다. `root`를 생략하면 호출자가 넘긴 절대 경로를 그대로 씁니다.

## 폴더 구조

```text
library/
  library.json
  <항목 ID>/
    item.json
    clip.mp4
  .trash/
```

`library.json`은 형식 버전, 자료库 이름, 생성 시각을 담습니다. `item.json`은 항목 ID, 제목, 출처, 저장 방식, 영상 경로, 자막 트랙을 담습니다.

## 동작

- `create`는 기존 폴더가 비어 있지 않으면 실패합니다.
- `import`는 복사와 연결을 모두 지원합니다. 복사 항목은 원본 이름을 그대로 항목 폴더에 복사합니다.
- `remove`는 `.trash` 폴더로 옮기고, `permanent`가 참이면 항목 폴더를 지웁니다.
- `relocate`는 원본 파일을 다시 지정합니다. 복사 항목은 새 파일을 항목 폴더로 복사합니다.
- `saveSubtitle`는 같은 ID의 트랙을 교체하고, 새 ID는 목록 끝에 붙입니다.

## 거부하는 입력

`library.json`의 `version`이 구현이 아는 버전보다 크면 `open`은 오류를 던집니다. 이 검사는 더 새로운 앱이 만든 자료库를 옛 앱이 손상시키지 않게 막습니다.

`item.json`의 필드가 비어 있거나 시간 범위가 뒤집힌 자막 구간이 있으면 `read`가 오류를 던집니다.
