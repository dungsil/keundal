# @keundal/plugin-fs-policy

파일 공급자를 감싸 경로 권한과 읽기 전 수정 방지를 적용합니다.
정책 서비스도 `FileSystemService`를 구현하므로 파일 도구는 공급자와 정책을 구별하지 않습니다.
이 패키지는 Node.js 파일 API를 가져오지 않습니다.

```ts
import localFileSystemPlugin from '@keundal/plugin-fs-local'
import fileSystemPolicyPlugin from '@keundal/plugin-fs-policy'
import { Context } from 'cordis'

const ctx = new Context()
const raw = ctx.isolate('fs')
const provider = await raw.plugin(localFileSystemPlugin, { cwd: '/workspace/project' })
const policy = await ctx.plugin(fileSystemPolicyPlugin, {
  backend: raw.fs,
  roots: ['/workspace/project'],
  writableRoots: ['/workspace/project/src']
})

const options = { scope: 'thread-1' }
const file = await ctx.fs.read('src/index.ts', options)
await ctx.fs.write('src/index.ts', file.content + '\n', options)
await policy.dispose()
await provider.dispose()
```

원본 공급자는 `ctx.isolate('fs')`에 등록합니다. 정책을 적용한 서비스만 에이전트에 연결하십시오.
`backend`는 명시적으로 전달한 서비스입니다. 공급자를 교체하면 정책도 새 공급자로 다시 등록하십시오.
정책을 해제해도 원본 공급자는 해제하지 않습니다. 호스트가 두 플러그인의 수명을 관리합니다.

## 권한과 읽기 기록

`roots`는 필수 읽기 허용 경로입니다. 수정할 경로는 `roots`와 `writableRoots` 모두에 속해야 합니다.
`writableRoots`를 생략하면 모든 수정을 거부합니다.
각 작업은 공급자의 `resolve()`와 `contains()`로 실제 경로를 검사합니다.
외부를 가리키는 심볼릭 링크와 이름 접두사만 같은 인접 디렉터리도 거부합니다.

수정 요청에는 비어 있지 않은 `scope`가 필요합니다. 파일 도구는 실행의 `threadId`를 사용합니다.
기존 파일은 같은 `scope`에서 읽어야 교체하거나 편집할 수 있습니다.
다른 대화에서 읽은 버전을 직접 전달해도 이 검사를 생략할 수 없습니다.
새 파일은 읽지 않고 만들 수 있지만 기존 파일을 덮어쓰지 않습니다.

읽은 뒤 외부에서 바뀐 파일은 다시 읽어야 수정할 수 있습니다. 성공한 수정은 새 버전을 기록합니다.

읽기 기록은 메모리에만 보관합니다. 기본 한도는 128개 scope와 scope당 1024개 파일입니다.
`maxScopes`와 `maxFilesPerScope`로 한도를 바꿉니다. 한도에 도달하면 가장 먼저 기록한 항목을 지웁니다.
기록이 사라진 기존 파일은 다시 읽기 전까지 수정할 수 없습니다.

`PolicyFileSystemService.forget(scope)`로 대화의 기록을 지울 수 있습니다.
플러그인을 해제하면 모든 기록을 지우고 진행 중 작업의 취소 신호를 전달합니다.

## 보안 한계

정책은 협력하는 호출자의 파일 작업을 제한합니다. 악의적인 호스트 코드에 대한 보안 경계가 아닙니다.
검사와 실행 사이에 다른 프로세스가 경로나 심볼릭 링크를 바꾸는 공격은 막지 못합니다.
원본 공급자의 직접 호출과 Shell 명령은 이 정책을 거치지 않습니다.
신뢰할 수 없는 실행에는 OS 격리와 최소 권한을 함께 적용하십시오.
