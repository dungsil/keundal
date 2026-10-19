# 이슈 트래커: GitHub

이 저장소의 이슈와 제품 요구 문서(PRD)는 GitHub 이슈로 관리된다. 모든 작업에 `gg` CLI를 사용한다.

## 한국어 작성

한국어 이슈, PR, 리뷰 또는 댓글의 초안을 쓰기 전에 설치된 `vibe-docs` 스킬을 읽고 `필수 적용 순서`를 따른다. `CONTEXT.md`, 이 주제를 다루는 아키텍처 결정 기록(ADR), `docs/agents/`에 정의된 도메인 용어와 라벨 문자열은 번역하거나 일반화하거나 중립화하지 않고 원래 표기를 그대로 쓴다.

## 규칙

- **이슈 생성**: `gg issue create --title "..." --body "..."`. 두 줄 이상의 본문에는 heredoc을 쓴다.
- **이슈 읽기**: `gg issue view <number> --comments`로 댓글을 `jq`로 걸러내고 라벨도 함께 가져온다.
- **이슈 목록**: `gg issue list --state open --json number,title,body,labels,blockedBy,subIssues --jq '[.[] | {number, title, body, labels: [.labels[].name], blockedBy, subIssues}]'`에 알맞은 `--label`과 `--state` 필터를 적용한다. 댓글은 이 목록에서 가져오지 않고, `gg issue view <number> --comments`로만 읽는다.
- **이슈 댓글**: `gg issue comment <number> --body "..."`
- **라벨 적용 / 제거**: `gg issue edit <number> --add-label "..."` / `--remove-label "..."`
- **닫기**: `gg issue close <number> --comment "..."`. 다른 저장소의 이슈면 `-R <owner>/<repo>`를 붙인다. `gg`는 이 클론의 remote에서 저장소를 추론하므로 빼면 이 저장소의 같은 번호 이슈를 닫는다.

저장소는 `git remote -v`에서 추론한다. 클론 안에서 `gg`를 실행하면 자동으로 처리된다.

## 외부 PR을 기능 요청으로 취급하는 설정

**PR을 요청 표면으로: 아니오.** _(이 저장소가 외부 PR을 기능 요청으로 취급하면 `yes`로 설정한다. `vibe-plan`의 트리아지 단계가 이 플래그를 읽는다.)_

`yes`로 설정하면 PR도 이슈와 같은 라벨과 상태를 쓰며, `gg pr` 동등 명령을 사용한다:

- **PR 읽기**: `gg pr view <number> --comments`와 diff용 `gg pr diff <number>`.
- **트리아지에 쓸 외부 PR 목록**: `gg pr list --state open --json number,title,body,labels,author,authorAssociation,comments`에서 `authorAssociation`이 `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`인 것만 남긴다(`OWNER`/`MEMBER`/`COLLABORATOR`는 제거).
- **댓글 / 라벨 / 닫기**: `gg pr comment`, `gg pr edit --add-label`/`--remove-label`, `gg pr close`.

GitHub는 이슈와 PR이 번호 공간을 공유하므로 단순 `#42`는 둘 중 하나일 수 있다. `gg pr view 42`로 확인하고 실패하면 `gg issue view 42`를 실행한다.

## 스킬이 "이슈 트래커에 게시"라고 말할 때

GitHub 이슈를 생성한다.

## 스킬이 "대상 티켓을 가져오라"고 말할 때

`gg issue view <number> --comments`를 실행한다.

## 닫기 참조를 넣어 PR을 게시하는 방법

이 절은 독립 실행 `/vibe-implement`가 PR을 게시할 때 적용한다. 사람이 UI에서 **Merge**를 누르는 행위가 닫기 승인이다. 리뷰 통과는 승인이 아니다.

**자격 조건.** 셋이 모두 참일 때만 closing keyword를 쓴다:

1. 이 저장소가 호스팅 트래커(GitHub 이슈)를 쓴다.
2. PR base가 저장소의 default branch다. `gg repo view --json defaultBranchRef --jq .defaultBranchRef.name`으로 확인한다.
3. 머지하면 인수 조건이 모두 끝나는 구현 티켓이 **정확히 하나**다.

**참조 문법**

- 같은 저장소: PR 본문에 `Closes #<ticket>` 한 줄.
- 다른 저장소: `Closes <owner>/<repo>#<ticket>` 전체 참조. 그냥 `#<n>`은 다른 저장소를 가리키지 못한다.
- keyword는 `close` / `closes` / `closed` / `fix` / `fixes` / `fixed` / `resolve` / `resolves` / `resolved`이고 대문자와 콜론도 된다(`Closes: #10`). GitHub은 `implement` 계열을 keyword로 보지 않는다.
- 티켓 하나에 keyword 하나. 한 PR이 둘 이상의 티켓을 닫지 않는다.
- 닫기 키워드는 **PR 본문에만** 둔다. PR 제목과 그 안의 커밋 메시지에는 닫기 키워드가 없어야 한다. squash merge는 PR 제목을 merge commit subject로 쓴다. 커밋 메시지의 keyword도 default branch로 머지될 때 이슈를 닫는다. 두 문자열 모두 `closingIssuesReferences`에 나오지 않으므로 "정확히 하나" 검증에서 이 둘을 확인하지 못한다.
- 부모 명세 이슈는 절대 닫기 대상으로 삼지 않는다. 같은 저장소면 `Part of #<parent>`, 다른 저장소면 `Part of <owner>/<repo>#<parent>`로만 적는다. 다른 저장소의 부모 이슈를 그냥 `#<parent>`로 줄이지 않는다. 하위 이슈 링크나 작업 목록 체크는 닫기를 일으키지 않는다.
- GitHub UI의 **Development** 패널로 수동 연결한 이슈도 머지할 때 닫히고 `closingIssuesReferences`에 나타난다. 의도한 티켓 외에는 수동 연결을 만들지 않는다.
- 조사 / 프로토타입 / 인터뷰 티켓과 머지 뒤에도 인수 조건이 남는 티켓(배포나 수동 확인이 그 예다)은 닫기 대상이 아니다. 같은 저장소면 `Refs #<n>`, 다른 저장소면 `Refs <owner>/<repo>#<n>`으로 적는다.
- **닫기 참조를 낮출 때는 키워드만 바꾼다.** 닫기를 일으키는 참조에서 닫기 키워드(`Closes` 계열)만 `Refs`로 바꾸고 이슈 참조는 글자 그대로 보존한다: `Closes #<n>` → `Refs #<n>`, `Closes <owner>/<repo>#<n>` → `Refs <owner>/<repo>#<n>`, `Closes https://github.com/<owner>/<repo>/issues/<n>` → `Refs https://github.com/<owner>/<repo>/issues/<n>`. 다른 저장소 참조를 그냥 `Refs #<n>`으로 줄이면 이 저장소의 같은 번호 이슈를 가리켜 티켓 신원을 잃는다. 어느 저장소의 어느 이슈였는지 본문만으로는 복구할 수 없다. 아래 수동 닫기 절차와 `250 초과 hard stop` 절에서 같은 방식으로 키워드를 바꾼다.

**게시 뒤 대상을 검증한다.** 게시 직후 두 명령을 모두 실행한다:

```bash
gg pr view <PR> --json baseRefName,closingIssuesReferences \
  --jq '{base: .baseRefName, closes: [.closingIssuesReferences[].url]}'
gg pr view <PR> --json body --jq .body
```

- `base`가 default branch 이름과 정확히 같아야 한다.
- `closes`의 길이가 정확히 1이고 그 URL이 의도한 티켓이어야 한다. 항목에는 `number`와 `repository.owner.login`도 있어 다른 저장소 대상도 확인할 수 있다.
- 길이가 0이면 링크가 없다. 문법이나 base를 고친다. base가 default branch가 아니면 keyword는 무시되어 링크 자체가 생기지 않는다.
- 길이가 2 이상이면 출처를 가르고, PR 본문에서 온 항목은 키워드만 `Refs`로 낮추며 이슈 참조는 그대로 둔다. 같은 저장소는 `Refs #<n>`, 다른 저장소는 `Refs <owner>/<repo>#<n>`으로 바꾸고 `gg pr edit <PR> --body "..."`로 본문을 고친다. UI Development 패널의 수동 연결은 본문 편집으로 지워지지 않으므로 UI에서 해제한다. 고친 뒤에는 이 검증만 반복하지 않고 전체 검증을 처음부터 다시 실행한다. 순서는 커밋 수 확인 → 본문 직접 확인과 대상 검증(수동 연결 포함) → 제목 검사 → 전체 커밋 메시지 검사다. 커밋 수가 250을 넘으면 전체 커밋 메시지 검사를 중단하고 `250 초과 hard stop` 절로 간다.
- 마지막 명령은 PR 본문 전체를 낸다. base나 link 상태와 무관하게 본문에서 closing keyword+이슈 참조 조합을 직접 세어, 의도한 한 줄 말고는 **0**인지 확인한다. base가 default branch가 아니면 keyword가 무시되어 `closingIssuesReferences`가 비므로 본문 잔여물이 그 목록에는 전혀 보이지 않는다. 나중에 default branch로 retarget되면 그 잔여물이 그대로 발동해 이슈를 닫는다.
- 두 검증은 서로 다른 질문에 답한다. 본문을 직접 확인하면 본문에 남은 닫기 키워드와 이슈 참조를 찾는다. `closingIssuesReferences`에는 본문에 자동으로 연결된 참조와 UI의 Development 패널에서 직접 연결한 이슈가 나온다. 본문 확인 결과가 0인데 `closingIssuesReferences`가 비어 있지 않으면 남은 항목은 UI에서 직접 연결한 이슈다. UI에서 연결을 해제한다.
- 이 목록은 **PR 본문의 closing keyword와 UI Development 패널의 수동 link**를 함께 반영한다. PR title과 commit message의 keyword는 여기에 나오지 않으므로 이 검증만으로는 숨은 close를 잡지 못한다. 반대로 여분 항목을 무조건 본문 keyword로 보고 본문만 고치면 수동 link는 그대로 남는다.

**게시 뒤 PR 제목과 커밋 수를 확인한다.** 위 검증과 함께 두 명령을 모두 실행한다:

```bash
gg pr view <PR> --json title --jq .title
gg api 'repos/{owner}/{repo}/pulls/<PR>' --jq .commits
```

- 첫 명령은 PR title을 낸다. squash merge는 PR title을 merge commit subject로 쓰므로 title에 닫기 키워드와 이슈 참조가 함께 있으면 이슈는 머지할 때 닫힌다.
- 둘째 명령은 PR의 전체 commit 수를 낸다. **250을 넘으면** REST pull-commits endpoint가 최대 250 commit까지만 돌려주므로 모든 commit message를 완전히 검증할 수 없다. 자동 닫기와 대체 수동 닫기 절차를 모두 쓰지 않는다. 아래 **`250 초과 hard stop`** 절로 간다.
- 커밋 수는 첫 게시 뒤뿐 아니라 PR 제목, 본문, 커밋 메시지를 고쳐 다시 push한 모든 경로에서 확인한다. 이때 전체 커밋 수 확인 명령을 가장 먼저 실행한다. rewrite는 커밋 수를 바꾸므로 push 전 수치는 믿을 수 없고, 이전에 250 이하였던 PR도 rewrite 뒤에는 250을 넘을 수 있다. 250을 넘으면 전체 커밋 메시지 검사를 중단하고 아래 `250 초과 hard stop` 절로 간다. 250 이하면 전체 검증을 처음부터 다시 실행한다. 순서는 커밋 수 확인, 본문 직접 확인과 대상 검증(수동 연결 포함), 제목 검사, 전체 커밋 메시지 검사다.

**게시 뒤 커밋 메시지를 검사한다.** 커밋 수가 **250 이하일 때만** 실행한다:

```bash
gg api --paginate 'repos/{owner}/{repo}/pulls/<PR>/commits?per_page=100' --jq '.[].commit.message'
```

- 이 명령은 `--paginate`로 모든 커밋 페이지의 전체 메시지를 낸다. `gg pr view <PR> --json commits`는 첫 페이지만 주므로 100개가 넘는 PR에서 뒤쪽 페이지의 숨은 키워드를 놓친다. 그래서 REST API로 모든 커밋 메시지를 가져온다. 경로는 반드시 작은따옴표로 감싼다. 작은따옴표로 감싼 `{owner}`와 `{repo}`는 셸이 바꾸지 않고 `gg api`가 이 클론의 값으로 채운다. 다른 저장소에서는 `owner/repo`를 직접 적는다.
- 제목 출력과 커밋 메시지 출력에는 닫기 키워드와 이슈 참조가 함께 있으면 안 된다. 키워드는 `close` / `closes` / `closed` / `fix` / `fixes` / `fixed` / `resolve` / `resolves` / `resolved`이며, 대문자와 콜론도 허용한다. 커밋 메시지는 두 줄 이상일 수 있다. 키워드와 참조가 서로 다른 줄에 있어도 같은 메시지 안에서 일치한 것으로 본다.
- 사람이 UI에서 머지 제목이나 머지 메시지를 편집할 때도 의도한 PR 본문 연결 외에 닫기 키워드와 이슈 참조를 함께 추가하지 않아야 한다. UI에서 편집한 내용은 게시 뒤 검증 다음에 생겨 검사에 잡히지 않는다. 그대로 merge commit이 되면 다른 이슈까지 닫는다. PR을 사람에게 넘길 때 이 점을 함께 알린다.
- 하나라도 발견되면 PR 제목과 본문을 각각 `gg pr edit <PR> --title "..."`와 `gg pr edit <PR> --body "..."`로 고친다. 커밋 메시지는 `git commit --amend` 또는 `git rebase -i`로 다시 쓴다. 원격 branch 기록을 덮어쓰며 복구하지 못할 수 있음을 사용자에게 먼저 알린 뒤, `--force-with-lease`로 push한다. rewrite로 커밋 수가 바뀌므로 고치기 전 수치는 믿지 말고 `gg api 'repos/{owner}/{repo}/pulls/<PR>' --jq .commits`로 push한 뒤 전체 커밋 수를 가장 먼저 확인한다. 커밋 수가 250을 넘으면 전체 커밋 메시지 검사를 중단하고 `250 초과 hard stop` 절로 간다. 250 이하면 커밋 수 확인 → 본문 직접 확인과 대상 검증 → 제목 검사 → 전체 커밋 메시지 검사 순서로 네 검증을 다시 실행한다.
- 고치기가 불가능하거나 안전하지 않으면 자동 닫기를 쓰지 않는다. PR 본문 닫기 줄에서는 키워드만 `Refs`로 바꾼다. 같은 저장소는 `Refs #<n>`, 다른 저장소는 `Refs <owner>/<repo>#<n>`을 쓰고 전체 URL은 그대로 둔다. 안전하게 작업을 멈추고 수동으로 이슈를 닫는 절차로 넘어간다.
- 이슈를 정확히 하나만 닫으려면 네 조건을 충족한다. 전체 커밋 수는 250 이하여야 하며, `closingIssuesReferences`에는 의도한 티켓 하나만 있어야 한다. PR 제목과 모든 커밋 메시지에는 닫기 키워드와 이슈 참조가 함께 있으면 안 된다. 커밋 수가 250을 넘으면 마지막 조건을 확인할 수 없어 자동 닫기 자격이 없다. 완전한 검증이 불가능하므로 수동 닫기 절차도 쓸 수 없다(아래 `250 초과 hard stop` 절 참고).

**수동 닫기 절차.** **커밋 수 ≤ 250일 때만** 적용한다. 커밋 수가 250을 넘으면 아래 `250 초과 hard stop` 절로 간다. 자동 닫기는 쓰지 않는다. 대상 branch에 변경 사항이 반영됐다는 증거, 정확한 미리보기, 별도 승인이 있을 때만 수동으로 닫는다:

- base가 default branch가 아니거나 게시 뒤 retarget되었다.
- PR이 머지 없이 닫혔다. 자동 닫기는 일어나지 않고 이슈는 열린 상태다.
- 닫을 대상 티켓이 정확히 하나가 아니다(0개, 둘 이상이거나 부모 이슈만 있다).
- 검증 명령이 기대와 다른 목록을 낸다.
- PR title이나 PR의 commit message에 closing keyword가 남아 있고 안전하게 고칠 수 없다.
- `closingIssuesReferences`의 여분 항목이 UI Development 패널의 수동 link인데 UI에서 unlink할 수 없다.
- 제거하거나 낮춘 뒤에는 `gg api 'repos/{owner}/{repo}/pulls/<PR>' --jq .commits`로 커밋 수를 **가장 먼저** 다시 확인한다. 250을 넘으면 모든 커밋 메시지를 확인할 방법이 없어 모든 항목이 0이라는 증거를 만들 수 없으므로 아래 `250 초과 hard stop` 절로 간다. 250 이하면 PR 본문에서 닫기 키워드와 이슈 참조가 함께 있는지 직접 살핀다(`gg pr view <PR> --json body --jq .body`). 다음으로 `closingIssuesReferences`가 0인지 확인하며, 이 값에는 본문 연결과 UI Development 패널의 수동 연결이 모두 포함된다. PR 제목과 모든 커밋 메시지에서도 닫기 키워드와 이슈 참조가 함께 있는지 확인한다. 이 순서대로 네 항목이 모두 0일 때만 수동 닫기 절차를 시작한다.

수동 닫기는 대상 이슈가 있는 저장소를 명시한 명령으로 실행한다. 다른 저장소 티켓이면 `gg issue close <number> -R <owner>/<repo> --comment "..."`. `-R`을 빼면 `gg`가 이 클론의 remote에서 저장소를 추론해 이 저장소의 같은 번호 이슈를 닫는다. 같은 저장소면 `-R`이 없어도 되고 붙여도 결과가 같다. 대상은 `Refs`로 낮춘 줄에 보존된 참조에서 그대로 읽는다. 따라서 참조를 낮출 때 `<owner>/<repo>` 부분을 지우면 안 된다.

**`250 초과 hard stop`.** PR의 전체 커밋 수가 250을 넘으면 완전한 검증이 불가능하므로 자동 닫기와 수동 닫기 절차를 모두 진행하지 않는다:

1. PR 본문에서 닫기 참조를 일반 참조로 바꾼다. 닫기 키워드만 `Refs`로 바꾸고, 같은 저장소는 `Refs #<n>`, 다른 저장소는 `Refs <owner>/<repo>#<n>`, 전체 URL은 그대로 둔다.
2. UI Development 패널에서 수동 연결한 이슈를 연결 해제한다.
3. 본문을 직접 확인해 닫기 키워드와 이슈 참조가 함께 남았는지 센다. `closingIssuesReferences`도 읽어 본문 연결과 UI 수동 연결을 확인한다.
4. 본문 확인 결과와 `closingIssuesReferences`의 결과를 기록한다. UI에서 연결 해제할 수 없는 Development 패널 수동 이슈는 남을 수 있다. 이 단계에서는 0개를 요구하지 않는다. 남은 항목이 있어도 hard stop 절차를 계속한다. 커밋 메시지는 여전히 검증되지 않았으므로 결과와 관계없이 다음 단계로 간다.
5. 그다음 머지 요청을 **중단한다**. PR을 완료로 반환하지 않고, 머지를 요청하지 않으며, 수동 닫기 절차 완료로 표시하지 않는다.
6. PR의 전체 커밋 수를 250 이하로 줄이도록 이력을 squash, rewrite 또는 split한다.
7. 원격 branch 기록을 덮어쓰며 복구하지 못할 수 있음을 사용자에게 먼저 알린 뒤, `--force-with-lease`로 push한다.
8. 리뷰와 이 문서의 모든 검증을 처음부터 다시 실행한다. 순서는 전체 커밋 수 확인, 본문 직접 확인과 닫기 대상 검증(수동 연결 포함), PR 제목 검사, 전체 커밋 메시지 검사다. 커밋 수 확인을 맨 앞에 둔다. squash 또는 rewrite로 커밋 수가 늘거나 250을 넘으면 커밋 메시지 검사를 중단하고 6단계로 돌아간다. 모든 검사를 통과하기 전에는 결과를 반환하거나 머지하지 않는다.

closing 대상을 되돌리는 방법은 출처에 따라 다르다. PR 본문 keyword에서 의도를 먼저 가른다. 닫기 대상을 제거하려면 본문에서 해당 줄을 통째로 지운다. 자동 닫기만 막고 참조를 수동 닫기 절차, hard stop, 수동 닫기에서 유지하려면 키워드만 `Closes` 계열에서 `Refs`로 바꾼다.

같은 저장소는 `Refs #<n>`, 다른 저장소는 `Refs <owner>/<repo>#<n>`으로 적는다. 전체 URL은 그대로 둔다. 수동으로 닫을 때는 이 줄에 남긴 참조에서 대상 저장소와 번호를 읽는다. 참조를 지우면 어느 저장소의 어느 이슈인지 알 수 없다.

UI Development 패널의 수동 연결은 본문 편집이나 `gg pr edit --body`로 지워지지 않는다. UI에서 연결을 해제한다.

## 담당자 지정

`gg`는 이슈 담당자 플래그를 중계하지 않는다. 담당자는 `gg api`로 지정한다. `<owner>/<repo>`와 `<n>`은 대상 이슈의 저장소와 번호로 바꾼다.

1. 현재 사용자 이름을 읽는다. `gg api user --jq .login`
2. 대상 이슈의 담당자 목록을 읽는다. `gg api repos/<owner>/<repo>/issues/<n> --jq '[.assignees[].login]'`
3. 목록에 내가 아닌 담당자가 있으면 목록을 덮어쓰지 않고 그 사실을 보고한다. 목록이 비었거나 내 이름만 있으면 다음 명령으로 나를 담당자로 지정한다. `gg api --method PATCH repos/<owner>/<repo>/issues/<n> -f 'assignees[]=<login>'`
4. 2번 명령을 다시 실행해 목록에 내 이름이 있는지 확인한다. 확인하지 못하면 지정에 성공했다고 보고하지 않는다.

지정을 해제할 때는 2번의 목록이 내 이름뿐일 때만 다음 명령을 실행한다. 이 명령은 담당자 목록을 빈 배열로 바꾼다. `gg api --method PATCH repos/<owner>/<repo>/issues/<n> -f 'assignees[]'`

## 경로 탐색 작업

`/vibe-deep-plan`이 사용한다. **맵**은 하위 이슈를 가진 단일 이슈다.

- **맵**: `상태:초안`과 `유형:계획` 라벨이 붙은 단일 이슈로 Notes / Decisions-so-far / Fog 본문을 가진다. `gg issue create --label "상태:초안" --label "유형:계획"`.
- **하위 이슈**: 먼저 일반 이슈를 만든 뒤 숫자 database id를 `gg api repos/<owner>/<repo>/issues/<child> --jq .id`로 구한다. `gg api --method POST repos/<owner>/<repo>/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>`로 GitHub native sub-issue 관계를 추가한다. 곧바로 `gg api repos/<owner>/<repo>/issues/<map>/sub_issues --jq 'map(.number)'`를 다시 읽어 `<child>`가 있는지 확인한다. 고수준 도구에 관계 추가 기능이 없어도 GitHub에서 하위 이슈가 꺼진 것은 아니다. 이 경우 허용된 `gg api`를 사용한다. 쓰거나 다시 확인하지 못하면 본문의 `Parent map`, 링크, 작업 목록만으로 성공했다고 보지 않는다. 만들어졌지만 연결되지 않은 이슈 번호와 실패한 연산을 보고하고 멈춘다. GitHub API가 이 저장소에서 하위 이슈 기능을 지원하지 않는다고 명확히 응답한 경우에만 맵 본문의 작업 목록과 하위 본문 맨 위 `Part of #<map>`으로 대체한다. 라벨: `유형:조사` / `유형:프로토타입` / `유형:인터뷰` / `유형:작업`. 담당자를 지정할 때는 [담당자 지정](#담당자-지정) 절차로 티켓을 주도하는 개발자를 할당한다.
- **차단**: GitHub UI에 차단 관계로 표시되는 기본 이슈 의존성 기능을 쓴다. `gg api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`로 간선을 추가하며, `<blocker-db-id>`는 차단 이슈의 숫자 **데이터베이스 id**(`gg api repos/<owner>/<repo>/issues/<n> --jq .id`, `#number`나 `node_id`가 아님)이다. 열린 차단은 `gg issue list --json blockedBy`의 `blockedBy`(`totalCount` / `nodes`)로 본다. list 출력에서 `issue_dependencies_summary`를 읽지 않는다. `blockedBy`나 네이티브 의존성을 쓸 수 없으면 하위 본문 맨 위에 `Blocked by: #<n>, #<n>` 줄로 되돌아간다. 모든 차단 이슈가 닫히면 티켓이 차단 해제된다.
- **프론티어 질의**: 맵의 열린 하위 목록을 `gg issue list --state open --json number,title,labels,blockedBy,assignees,subIssues`로 가져온다. 목록은 맵의 하위 이슈나 작업 목록에 있는 항목으로 제한한다. 열린 차단이 있거나 담당자가 있는 이슈를 제외한다. 남은 이슈에서는 맵 순서가 빠른 것을 우선한다. 열린 차단은 `blockedBy.totalCount > 0`, 비어 있지 않은 `blockedBy.nodes`, 또는 `Blocked by` 줄의 열린 이슈로 확인한다.
- **담당자 지정**: [담당자 지정](#담당자-지정) 절차로 현재 사용자를 지정한다.
- **조사 담당자 지정 해제**: 차팅 중에는 완전한 결과와 조사 기록 포인터를 저장한 뒤 [담당자 지정](#담당자-지정) 절차로 지정을 해제한다. 조사 이슈는 열어두고 맵 gist를 추가하지 않는다. 저장에 실패하거나 세션을 마칠 때 미완료 작업이 남으면 담당자를 유지한다.
- **해결**:
  1. `gg issue comment <n> --body "<답안>"`로 답변을 댓글로 남긴다.
  2. `gg issue close <n>`를 실행한다.
  3. 맵의 Decisions-so-far에 컨텍스트 포인터(gist + 링크)를 덧붙인다.


## 조사 기록 저장

- 호출자가 출처 인용을 포함한 완전한 결과를 같은 조사 이슈에 전용 댓글 하나로 올린다. 이후 세션이 불변 이슈 신원으로 찾을 수 있도록 `<!-- vibe-deep-plan research: <map-issue>/<ticket-issue> -->`로 시작한다.
- 댓글이 GitHub 한도를 넘으면 순서 댓글(`Research record 1/N`, `2/N`, ...)이나 저장소 소유 위키, 스니펫, 첨부, 동등한 영속 산출물을 사용하고 이슈 댓글에서 그 기록을 링크한다. 결과를 자르거나 로컬 파일에만 두지 않는다.
- 티켓에 `Research record: <댓글 또는 산출물 URL>`을 기록한다. 호스팅 조사는 `Branch`, `Commit`, `Path` 포인터가 없으며 `research/...` branch를 만들거나 푸시하지 않는다.
- 차팅 중에는 조사 이슈를 열어두고 맵 gist를 추가하지 않는다. 저장에 성공하면 [담당자 지정](#담당자-지정) 절차로 지정을 해제한다. 저장에 실패하면 이슈 담당자를 유지한다. 다시 실행하기 전에 기존 댓글과 연결된 산출물을 먼저 확인한다.
