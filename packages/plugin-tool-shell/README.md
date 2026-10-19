# @keundal/plugin-tool-shell

주입한 `shell` 서비스를 `shellTools.tools`의 단일 `shell` 도구로 제공합니다.
이 패키지는 프로세스를 직접 실행하지 않으며 전역 도구 목록을 만들지 않습니다.
에이전트 도구 타입만 참조하고 실행할 때 에이전트 패키지를 가져오지 않습니다.

```ts
import agent from '@keundal/plugin-agent-simple'
import localShellPlugin from '@keundal/plugin-shell-local'
import shellToolsPlugin from '@keundal/plugin-tool-shell'
import { Context } from 'cordis'

const ctx = new Context()
// llm, session, generation 공급자도 등록하십시오.
await ctx.plugin(localShellPlugin, { cwd: '/workspace/project' })
await ctx.plugin(shellToolsPlugin)
await ctx.plugin({
  inject: ['shellTools'],
  apply(ctx) {
    ctx.plugin(agent, {
      model: 'your-model',
      maxOutputTokens: 4096,
      tools: ctx.shellTools.tools
    })
  }
})
```

도구는 필수 `command`와 선택 `cwd`, `timeoutMs`를 검증합니다.
정의하지 않은 필드는 거부합니다. 실행 컨텍스트의 취소 신호를 공급자에게 그대로 전달합니다.
반환값은 `ShellResult`의 JSON 문자열입니다. 경로와 시간 한도는 공급자가 검사합니다.
`shellTools`는 `shell` 주입을 요구하므로 Node.js 공급자 대신 Tauri나 원격 서버 공급자를 연결할 수 있습니다.

셸 도구는 샌드박스가 아닙니다. 로컬 공급자의 `cwd` 검사로 명령의 외부 접근을 막을 수 없습니다.
신뢰할 수 없는 모델의 명령에는 OS 격리와 권한 제한을 적용하십시오.
