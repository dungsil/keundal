# @keundal/fs

파일 공급자와 정책 구현이 공유하는 서비스 계약입니다. Node.js 파일 API에는 의존하지 않습니다.
`FileSystemService`와 파일 작업에 사용하는 타입을 내보내고 Cordis Context에 `ctx.fs` 타입을 추가합니다.

```ts
import { FileSystemService, type FileSnapshot, type FileMutationOptions } from '@keundal/fs'
```

- [plugin-fs-local](../plugin-fs-local/README.md)은 Node.js 파일 접근을 구현합니다.
- [plugin-fs-policy](../plugin-fs-policy/README.md)는 공급자를 감싸 경로 권한과 읽기 기록을 검사합니다.
- [plugin-tool-fs](../plugin-tool-fs/README.md)는 주입된 `ctx.fs`를 에이전트 도구에 연결합니다.

기존에 `@keundal/core`에서 가져온 `FileSystemService`, `FileSystemOptions`, `FileMutationOptions`, `FileSnapshot`, `FileMutation`, `DirectoryEntry`, `FileEdit`는 `@keundal/fs`에서 가져오십시오.
공통 취소 옵션인 `ExecutionOptions`는 계속 `@keundal/core`에서 제공합니다.
