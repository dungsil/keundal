# @keundal/plugin-fs-local

Node.js 파일 API로 `ctx.fs`를 구현합니다. 서비스 계약은 `@keundal/fs`의 `FileSystemService`에 있습니다.

```ts
import localFileSystemPlugin from '@keundal/plugin-fs-local'
import { Context } from 'cordis'

const ctx = new Context()
const provider = await ctx.plugin(localFileSystemPlugin, { cwd: '/workspace/project' })
const file = await ctx.fs.read('README.md')
await ctx.fs.write('README.md', file.content + '\n', { expectedVersion: file.version })
await provider.dispose()
```

`cwd`는 상대 경로의 기준이며 기본값은 프로세스의 작업 디렉터리입니다.
이 설정은 접근 권한을 제한하지 않습니다. 경로 제한에는 `plugin-fs-policy`를 연결하십시오.
`maxFileBytes`는 읽기와 쓰기의 바이트 한도입니다. 기본값은 1MiB입니다.

- `resolve()`는 심볼릭 링크를 해석합니다. 없는 경로는 기존 조상을 기준으로 해석합니다.
- `read()`는 UTF-8 내용, 경로, 버전을 반환합니다. 버전에는 내용과 파일 메타데이터를 반영합니다.
- `list()`는 바로 아래 항목의 이름과 종류를 반환하며 링크를 따라가지 않습니다.
- `write()`는 `expectedVersion`을 생략하거나 `null`로 지정하면 새 파일만 만듭니다.
- 기존 파일은 읽은 버전을 전달해야 교체할 수 있습니다. 버전이 다르면 원본을 유지하고 오류를 던집니다.
- `edit()`는 읽은 버전을 요구합니다. 비어 있지 않은 `oldText`가 정확히 한 번 나타날 때만 `newText`로 바꿉니다.

공급자는 기존 부모 디렉터리 안에 임시 파일을 만듭니다. 교체는 rename으로, 생성은 덮어쓰지 않는 link로 확정합니다.
부모 디렉터리를 자동으로 만들지 않으며 기존 파일의 모드를 보존합니다.
같은 공급자의 수정은 정규 경로별로 직렬화합니다. 실패하거나 확정 전에 취소하면 임시 파일을 지웁니다.

`signal`은 작업 단계마다 검사합니다. 플러그인을 해제하면 진행 중 작업도 취소합니다.
이미 확정한 수정은 취소로 되돌리지 않습니다.

## 한계

이 공급자는 텍스트 파일을 다룹니다. 임의 바이너리 파일을 수정하는 용도로 사용하지 마십시오.
파일 교체는 기존 inode와 하드 링크 관계를 유지하지 않습니다. ACL과 확장 속성도 복사하지 않습니다.
Windows의 파일 모드와 링크 동작은 별도 검증이 필요합니다.

버전 검사와 교체 사이에 다른 프로세스가 파일을 바꿀 수 있습니다.
이 공급자는 프로세스 간 CAS나 악의적인 링크 교체를 막는 OS 샌드박스가 아닙니다.
새 파일을 확정할 때 기존 파일을 덮어쓰지 않는 보장은 별도로 적용합니다.
전원 장애 뒤의 영속성은 보장하지 않습니다.
