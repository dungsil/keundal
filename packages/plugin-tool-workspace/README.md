# @keundal/plugin-tool-workspace

`ctx.workspace`를 주입받아 `ctx.workspaceTools.tools`에 Git 도구를 제공합니다. Git 구현 플러그인에는 의존하지 않습니다.

| 도구                  | 인자                 | 동작                                            |
| --------------------- | -------------------- | ----------------------------------------------- |
| `git_status`          | `taskId?`            | 변경 파일과 staged·unstaged·새 파일 상태 조회   |
| `git_diff`            | `taskId?`, `staged?` | 추적 파일의 Diff 조회                           |
| `git_apply_patch`     | `patch`, `taskId?`   | 앱의 검토를 거쳐 패치 적용                      |
| `git_create_worktree` | `taskId`             | 작업별 detached Worktree 생성 요청              |
| `git_remove_worktree` | `taskId`             | 변경 파일이나 새 커밋이 없는 Worktree 삭제 요청 |

도구 인자는 실행 시에도 검증합니다. 임의 저장소 경로·Shell 명령·`approved` 인자를 받지 않습니다. 실행의 취소 신호는 서비스에 전달합니다. 도구를 호출한 모델이 승인 여부를 결정하지 않으며 실제 승인은 서비스에 조립한 콜백이 담당합니다.

```ts
import codingAgentPlugin from '@keundal/plugin-agent-coding'
import workspaceToolsPlugin from '@keundal/plugin-tool-workspace'

// 먼저 앱이 ctx.workspace와 검토 콜백을 조립합니다.
await ctx.plugin(workspaceToolsPlugin)
await ctx.plugin({
  inject: ['workspaceTools'],
  apply(ctx) {
    ctx.plugin(codingAgentPlugin, {
      model: 'your-model',
      maxOutputTokens: 8192,
      tools: ctx.workspaceTools.tools
    })
  }
})
```

파일·Shell 도구를 함께 제공하면 해당 도구는 Workspace 검토 경계를 우회할 수 있습니다. 검토가 필요한 수정은 `git_apply_patch`로 제한하거나 각 도구에도 공통 승인 정책을 연결합니다. 작업별 파일·Shell 서비스는 `createWorktree()`가 반환한 경로에서 별도로 조립합니다.
