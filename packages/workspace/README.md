# @keundal/workspace

Git 작업공간의 조회·패치 검토·작업별 Worktree 계약과 `ctx.workspace`를 제공합니다. Node.js나 Git 실행에는 의존하지 않습니다. 로컬 구현은 [`@keundal/plugin-workspace-git`](../plugin-workspace-git/README.md), 에이전트 도구는 [`@keundal/plugin-tool-workspace`](../plugin-tool-workspace/README.md)가 담당합니다.

## 계약

| 메서드                           | 동작                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------- |
| `status({ taskId? })`            | 작업공간 경로, 브랜치, 변경 파일을 반환합니다. detached HEAD의 브랜치는 `null`입니다.         |
| `diff({ taskId?, staged? })`     | 추적 파일의 Git Diff를 반환합니다. 기본값은 unstaged이며 `staged: true`는 index를 조회합니다. |
| `applyPatch(patch, { taskId? })` | 적용 가능성을 검사하고 앱의 승인을 받은 패치를 적용합니다. index는 바꾸지 않습니다.           |
| `createWorktree(taskId)`         | 검토한 HEAD 커밋으로 detached Worktree를 만듭니다.                                            |
| `removeWorktree(taskId)`         | 작업 파일과 커밋을 보존할 필요가 없는 Worktree만 제거합니다.                                  |

모든 메서드는 `signal`을 받습니다. `taskId`를 생략한 조회와 패치 적용은 기본 저장소를 사용합니다. `status().changes`는 Git porcelain의 `index`와 `workingTree` 두 상태를 분리하며, 이름이 바뀐 파일은 `previousPath`도 반환합니다. 새 파일은 `??`로 표시하며 `diff()`에는 포함하지 않습니다.

## 검토 경계

`WorkspaceReviewer`는 `WorkspaceReview`와 취소 신호를 받고 `Promise<boolean>`을 반환합니다. 패치 검토에는 적용 경로·전체 패치·변경 통계가, Worktree 검토에는 작업 ID·경로·기준 HEAD가 포함됩니다. 앱은 이 콜백을 사용자 검토 화면이나 승인 정책에 연결합니다. 모델의 도구 인자로 승인을 받지 않습니다.

이 계약은 승인 화면이나 공통 승인 서비스 자체를 구현하지 않습니다. 파일·Shell 도구의 실행을 가로채지도 않습니다. 모든 수정을 통제하려는 앱은 다른 도구에도 같은 승인 정책을 적용해야 합니다.

## 대화 연결

`CodingWorkspaceClient`는 앱이 대화 ID로 프로젝트를 연결하는 계약입니다. `create(threadId, projectPath)`로 작업을 만들고, `get(threadId)`로 복원하며, `review(threadId)`가 반환한 전체 패치와 `reviewId`를 사용자에게 보여 줍니다. 사용자가 적용을 선택하면 `apply(threadId, reviewId)`를 호출합니다. 구현은 검토 뒤 작업이나 원본이 바뀌었으면 적용을 거부해야 합니다. 생성과 원본 적용은 모델 도구로 노출하지 않습니다.

`CodingWorkspaceSnapshot`의 `changes`는 작업의 적용 기준과 현재 파일을 비교한 상태입니다. 일반 `status()`의 index·workingTree 상태와 달리, 커밋 여부와 관계없이 적용할 변경을 나타냅니다. 기본 앱의 조립과 실행 방식별 제한은 [Node.js 호스트 문서](../agent-runtime-node/README.md#코딩-작업공간)를 참고합니다.
