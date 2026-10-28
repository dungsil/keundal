# @keundal/plugin-workspace-git

로컬 Git 실행으로 [`WorkspaceService`](../workspace/README.md)를 구현합니다. 시스템에 Git이 있어야 합니다. 앱이 저장소 경로와 검토 콜백을 선택합니다. 기본 Node.js 호스트의 대화별 연결은 [코딩 작업공간 문서](../agent-runtime-node/README.md#코딩-작업공간)를 참고합니다.

## 조립

```ts
import workspaceToolsPlugin from '@keundal/plugin-tool-workspace'
import gitWorkspacePlugin from '@keundal/plugin-workspace-git'
import type { WorkspaceReviewer } from '@keundal/workspace'
import type { Context } from 'cordis'

export async function installWorkspace(ctx: Context, review: WorkspaceReviewer) {
  await ctx.plugin(gitWorkspacePlugin, {
    cwd: '/projects/example',
    worktreeRoot: '/projects/example-tasks',
    review
  })
  await ctx.plugin(workspaceToolsPlugin)
}
```

`cwd`는 저장소의 최상위 디렉터리여야 합니다. `worktreeRoot`는 심볼릭 링크를 해석한 절대 경로이며 저장소 밖에 둡니다. 아직 없으면 승인 후 만듭니다. `review`를 생략하면 조회만 허용하며 패치 적용과 Worktree 생성·삭제를 거부합니다. 콜백은 실제 사용자 결정이나 승인 정책의 결과를 반환해야 합니다.

## 패치 적용

1. `git apply --check`로 전체 패치를 검사합니다.
2. 대상 파일의 내용과 모드를 기록하고 전체 패치와 변경 통계를 검토 콜백에 전달합니다.
3. 승인 후 경로와 대상 파일을 다시 확인합니다. 검토 중 내용이나 모드가 달라지면 적용하지 않습니다.
4. 적용 가능성을 다시 검사하고 index를 바꾸지 않은 채 적용합니다.

파일 생성·수정·삭제·이름 변경·복사와 바이너리 패치를 지원합니다. 이름 변경·복사는 원본과 대상 모두를 검사합니다. 심볼릭 링크·서브모듈 생성, Git 메타데이터와 저장소 밖 경로는 지원하지 않습니다. 파일 이름의 공백·탭·줄바꿈은 NUL 구분 출력으로 보존합니다. 패치 입력과 Git 출력은 각각 8 MiB, Git 명령은 30초로 제한하며 초과하면 오류로 전달합니다. 출력 일부를 정상 결과로 반환하지 않습니다.

동일 서비스의 수정 작업은 순서대로 실행합니다. 취소와 플러그인 해제는 Git 프로세스와 승인 대기를 중단합니다. 적용이 시작된 뒤의 취소가 이미 반영된 파일을 되돌리지는 않습니다. 외부 프로세스와 파일 시스템을 잠그지 않으므로 최종 검사와 적용 사이의 동시 수정을 완전히 막는 트랜잭션은 아닙니다.

## Worktree 수명

- 작업 ID는 영문·숫자로 시작하며 영문·숫자·`_`·`-`로 된 1~64자 문자열입니다.
- 검토 전에 HEAD를 고정하고 승인된 커밋으로 detached Worktree를 만듭니다. 기본 저장소의 미커밋 파일과 index는 복사하지 않습니다. 커밋이 없는 저장소에서는 Worktree를 만들 수 없습니다.
- 반환한 `path`에 앱이 파일·Shell 서비스를 별도로 조립하면 해당 작업에서 사용할 수 있습니다. 기존 파일·Shell 서비스의 경로를 자동으로 바꾸지 않습니다.
- 변경 파일·새 파일·무시된 파일이 있거나 HEAD가 생성 시점과 다르면 삭제를 거부합니다. `--force`는 사용하지 않으며 기본 저장소는 삭제 대상이 아닙니다.
- 작업 등록과 적용 기준은 Worktree 디렉터리 옆의 JSON 파일에 저장합니다. 재시작하면 같은 저장소에 속한 Worktree인지 확인한 뒤 복원하며, 해제할 때 작업 파일을 지우지 않습니다. 기존 경로나 작업 ID를 덮어쓰지 않습니다.

Git은 Shell 문자열이 아닌 인자 배열로 실행합니다. 상속한 `GIT_*` 환경 변수의 저장소 우회, Git 훅·fsmonitor·외부 Diff·textconv 실행을 차단합니다. 다만 저장소의 checkout 필터 등 Git 설정 전체를 격리하지는 않습니다. 신뢰할 수 있는 저장소에서 사용하고, 신뢰할 수 없는 코드에는 별도의 OS 격리를 적용합니다.
