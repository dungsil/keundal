# @keundal/plugin-tool-fs

주입한 `ctx.fs`를 에이전트의 실행 가능한 파일 도구로 노출합니다.
파일 접근과 권한 검사는 각각 공급자와 정책에 맡깁니다. 이 패키지는 Node.js 파일 API를 가져오지 않습니다.

```ts
import agent from '@keundal/plugin-agent-simple'
import localFileSystemPlugin from '@keundal/plugin-fs-local'
import fileSystemPolicyPlugin from '@keundal/plugin-fs-policy'
import fileSystemToolsPlugin from '@keundal/plugin-tool-fs'
import { Context } from 'cordis'

const ctx = new Context()
const raw = ctx.isolate('fs')
await raw.plugin(localFileSystemPlugin, { cwd: '/workspace/project' })
await ctx.plugin(fileSystemPolicyPlugin, {
  backend: raw.fs,
  roots: ['/workspace/project'],
  writableRoots: ['/workspace/project']
})
await ctx.plugin(fileSystemToolsPlugin)
// llm, session, generation 공급자도 등록하십시오.
await ctx.plugin({
  inject: ['fsTools'],
  apply(ctx) {
    ctx.plugin(agent, {
      model: 'your-model',
      maxOutputTokens: 4096,
      tools: ctx.fsTools.tools
    })
  }
})
```

`fsTools.tools`에는 다음 도구가 있습니다. 반환값은 서비스 결과의 JSON 문자열입니다.

- `read_file`: `path`의 UTF-8 내용과 버전을 읽습니다.
- `list_directory`: `path` 바로 아래 항목의 이름과 종류를 읽습니다.
- `write_file`: `path`에 `content`를 씁니다.
- `edit_file`: `path`에서 `oldText`를 `newText`로 한 번 바꿉니다.

정의한 필드는 모두 문자열이어야 합니다. 누락한 필드와 추가 필드는 거부합니다.
도구는 취소 신호와 `threadId`를 공급자에게 전달합니다. 읽기 기록은 정책이 관리합니다.
수정 도구가 내부에서 먼저 파일을 읽어 정책을 생략하지는 않습니다.
정책 없이 로컬 공급자만 연결하면 새 파일은 만들 수 있지만 기존 파일의 수정은 거부합니다.

`fs` 주입을 교체하면 Cordis가 도구 플러그인을 다시 구성합니다.
에이전트도 `fsTools`를 주입받는 상위 플러그인 안에서 구성해야 이 수명 변경을 따릅니다.
파일 도구와 Shell 도구를 함께 사용하려면 `tools: [...ctx.fsTools.tools, ...ctx.shellTools.tools]`로 전달하십시오.
상위 플러그인의 `inject`에도 `shellTools`를 추가하십시오.

Tauri에서는 `FileSystemService`를 IPC로 구현한 공급자로 로컬 공급자를 교체할 수 있습니다.
이번 패키지에는 Tauri IPC 구현이나 앱의 자동 도구 등록을 포함하지 않습니다.
