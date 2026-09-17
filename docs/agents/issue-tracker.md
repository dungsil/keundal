# Issue Tracker: GitHub

Issues and PRDs in this repository are managed as GitHub Issues. Use the `gh` CLI for all operations.

## Korean writing

Before drafting Korean issues, pull requests, reviews, or comments, read the installed `vibe-docs` skill and follow its `Required application order`. Preserve the exact form of domain terms and label strings defined in `CONTEXT.md`, relevant ADRs, and `docs/agents/`; do not translate, generalize, or neutralize them.

## Rules

- **Create Issue**: `gh issue create --title "..." --body "..."`. Use heredocs for multi-line bodies.
- **Read Issue**: `gh issue view <number> --comments`, filtering comments with `jq` and fetching labels alongside.
- **List Issues**: `gh issue list --state open --json number,title,body,labels,blockedBy,subIssues --jq '[.[] | {number, title, body, labels: [.labels[].name], blockedBy, subIssues}]'`, applying appropriate `--label` and `--state` filters. Do not request `comments` here — read comments with `gh issue view <number> --comments`.
- **Comment on Issue**: `gh issue comment <number> --body "..."`
- **Apply / Remove Labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`. For an issue in another repository, add `-R <owner>/<repo>` — `gh` infers the repository from the current clone's remote, so omitting it closes this repository's issue of the same number.

Repository is inferred from `git remote -v` — running `gh` inside a clone handles this automatically.

## Pull Requests as Triage Surface

**PRs as request surface: no.** _(Set to `yes` if this repository treats external PRs as feature requests. The triage stage of `vibe-plan` reads this flag.)_

When set to `yes`, PRs share labels and statuses with issues, using equivalent `gh pr` commands:

- **Read PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for diffs.
- **List External PRs for Triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`, retaining only those where `authorAssociation` is `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (filtering out `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / Label / Close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

Because GitHub shares number space between issues and PRs, a bare `#42` may refer to either — check with `gh pr view 42` and fall back to `gh issue view 42` if that fails.

## When a Skill Says "Post to Issue Tracker"

Create a GitHub Issue.

## When a Skill Says "Fetch Relevant Tickets"

Run `gh issue view <number> --comments`.

## Publishing PRs with Auto-Close References

Used when standalone `/vibe-implement` publishes a PR. A human pressing **Merge** in the UI is the close approval — passing review is not approval.

**Eligibility.** Use a closing keyword only when all three hold:

1. This repository uses a hosted tracker (GitHub Issues).
2. The PR base is the repository's default branch — check with `gh repo view --json defaultBranchRef --jq .defaultBranchRef.name`.
3. There is **exactly one** implementation ticket whose acceptance is complete at merge.

**Reference Syntax**

- Same repository: one `Closes #<ticket>` line in the PR body.
- Different repository: the full reference `Closes <owner>/<repo>#<ticket>`. A bare `#<n>` cannot point at another repository.
- Keywords are `close` / `closes` / `closed` / `fix` / `fixes` / `fixed` / `resolve` / `resolves` / `resolved`, and uppercase plus colons work (`Closes: #10`). GitHub does not treat the `implement` family as a keyword.
- One keyword for one ticket. A single PR never closes several tickets.
- The closing keyword lives **only in the PR body**. The PR title and every commit message in the PR must be free of closing keywords — a squash merge uses the PR title as the merge commit subject, and commit-message keywords also close issues when merged into the default branch. Neither appears in `closingIssuesReferences`, so both slip past the "exactly one" check.
- The parent spec issue is never a closing target — write only `Part of #<parent>` in the same repository, or `Part of <owner>/<repo>#<parent>` for another repository. Never shorten a cross-repository parent to a bare `#<parent>`. Sub-issue links and task list checkmarks cause no close.
- An issue manually linked via the GitHub UI **Development** panel also closes on merge and appears in `closingIssuesReferences`. Do not create manual links to any ticket other than the intended one.
- Research / prototype / interview tickets, and tickets whose acceptance continues after merge (deploy, manual verification, and so on), are not closing targets — write them as `Refs #<n>` in the same repository, or `Refs <owner>/<repo>#<n>` across repositories.
- **A downgrade changes the keyword only.** When lowering a closing reference to a non-closing one, replace just the keyword (the `Closes` family) with `Refs` and keep the issue reference verbatim: `Closes #<n>` → `Refs #<n>`, `Closes <owner>/<repo>#<n>` → `Refs <owner>/<repo>#<n>`, `Closes https://github.com/<owner>/<repo>/issues/<n>` → `Refs https://github.com/<owner>/<repo>/issues/<n>`. Shortening a cross-repository reference to a bare `Refs #<n>` points at this repository's issue of the same number and loses the ticket's identity — which issue in which repository it was can no longer be recovered from the body. Every downgrade in the fallback and in the `Above 250` hard stop below follows this rule.

**Target Verification After Publishing.** Run right after publishing:

```bash
gh pr view <PR> --json baseRefName,closingIssuesReferences \
  --jq '{base: .baseRefName, closes: [.closingIssuesReferences[].url]}'
gh pr view <PR> --json body --jq .body
```

- `base` must exactly equal the default branch name.
- `closes` must have length exactly 1 and that URL must be the intended ticket. Entries also carry `number` and `repository.owner.login`, so cross-repository targets can be confirmed too.
- Length 0 means no link exists — fix the syntax or the base. When the base is not the default branch, keywords are ignored and no link is created at all.
- Length 2 or more means first classify where the extra entries came from. For a PR-body keyword, downgrade the keyword alone to `Refs` and leave the reference untouched, so a same-repository entry becomes `Refs #<n>` and a cross-repository entry becomes `Refs <owner>/<repo>#<n>` (`gh pr edit <PR> --body "..."`). A manual link from the UI Development panel is unlinked in the UI — editing the body does not remove it. After the fix, do not run this verification alone — start from the commit count check and re-run the whole verification from scratch in the order count → direct body scan + body target verification (manual links included) → title scan → full commit message scan. If the count exceeds 250, do not proceed to the full commit message scan — go to the `Above 250` hard stop section below.
- The last command prints the whole PR body. Count closing keyword+issue reference pairs directly in that text, independent of base or link state — everything except the one intended line must be **0**. When the base is not the default branch, keywords are ignored so `closingIssuesReferences` is empty and body residue is invisible there — if the PR is later retargeted to the default branch, that residue fires and closes the issue.
- The two checks answer different questions. The direct body scan reports **body residue**; `closingIssuesReferences` reports **body-linked closing references plus manual links from the UI Development panel**. If the body scan is 0 and `closingIssuesReferences` is not empty, the remaining entry is a manual link — unlink it in the UI.
- This list reflects **PR-body closing keywords plus manual links from the UI Development panel**. Keywords in the PR title and in commit messages do not appear here, so this verification alone cannot catch a hidden close. Conversely, treating every extra entry as a body keyword and editing only the body leaves a manual link in place.

**Title / Commit Count Check After Publishing.** Run both commands alongside the verification above:

```bash
gh pr view <PR> --json title --jq .title
gh api 'repos/{owner}/{repo}/pulls/<PR>' --jq .commits
```

- The first command prints the PR title. A squash merge uses the PR title as the merge commit subject, so a title pairing a closing keyword with an issue reference closes that issue on merge.
- The second prints the PR's total commit count. **Above 250**, the REST pull-commits endpoint returns at most 250 commits, so the commit messages cannot be fully verified — neither native auto-close nor the manual-close fallback is used. Go to the **`Above 250` hard stop** section below.
- This count check is not for the first publish only. Re-run this command **first** on **every** path that rewrites the PR title, the body, or a commit message and pushes again — a rewrite changes the commit count, so any number taken before the push is untrustworthy, and a PR that was at 250 or fewer can cross 250 through the rewrite. Above 250, do not continue into the full commit message scan — go straight to the **`Above 250` hard stop** section below. At 250 or fewer, re-run the whole verification from scratch in the order count → direct body scan + body target verification (manual links included) → title scan → full commit message scan.

**Commit Message Scan After Publishing.** Run only when the commit count is **250 or fewer**:

```bash
gh api --paginate 'repos/{owner}/{repo}/pulls/<PR>/commits?per_page=100' --jq '.[].commit.message'
```

- The command walks every commit page via `--paginate` and prints each commit's full message. `gh pr view <PR> --json commits` returns only the first page, so it misses hidden keywords on later pages of PRs with more than 100 commits — hence the REST scan. Wrap the path in single quotes so the shell does not touch `{owner}`/`{repo}` (`gh api` fills them from the current clone); for a foreign repository write `owner/repo` literally.
- Neither the title output nor the commit message output may pair a closing keyword (`close` / `closes` / `closed` / `fix` / `fixes` / `fixed` / `resolve` / `resolves` / `resolved`, uppercase and colons included) with an issue reference anywhere. Commit messages span multiple lines, so a keyword and a reference on different lines of the same message still count as a hit.
- A human editing the merge title or merge message in the UI must not add any closing keyword+issue reference beyond the intended PR body link. UI edits happen after the post-publishing checks, escape the scans, and land directly in the merge commit, closing extra issues — tell the human this when handing the PR over.
- On any hit, fix it and push: `gh pr edit <PR> --title "..."` for the title, `gh pr edit <PR> --body "..."` for the body, or a commit rewrite (`git commit --amend` or `git rebase -i`) followed by a `--force-with-lease` push for commit messages. After the fix, re-check the PR's total commit count **first** with `gh api 'repos/{owner}/{repo}/pulls/<PR>' --jq .commits` — a rewrite changes the commit count, so the number from before the fix is untrustworthy. Above 250, do not continue into the full commit message scan — go straight to the `Above 250` hard stop section. At 250 or fewer, re-run all four checks from scratch in the order count → direct body scan + body target verification (manual links included) → title scan → full commit message scan.
- If fixing is impossible or unsafe, do not use auto-close — downgrade the closing line in the PR body by changing the keyword only, to a non-closing reference (`Refs #<n>` in the same repository, `Refs <owner>/<repo>#<n>` across repositories, a full URL left as the URL), and safe-stop into the manual-close fallback.
- Exactly one issue closes only when all four hold: the PR's total commit count is ≤ 250, `closingIssuesReferences` = 1 (that entry is the intended ticket), PR title closing keyword+issue reference = 0, and every commit message closing keyword+issue reference = 0. Above 250 commits the last condition cannot be checked at all, so auto-close is not eligible — and because full verification is impossible above 250, the manual-close fallback is not eligible either (see the **`Above 250` hard stop** section below).
**Fallback.** Applies **only when the commit count is ≤ 250**. Above 250 commits, go to the **`Above 250` hard stop** section below. In the fallback, skip auto-close and close manually with landing proof + an exact preview + separate approval:

- The base is not the default branch, or the PR was retargeted after publishing.
- The PR was closed without merging — auto-close never fires and the issue stays open.
- There is not exactly one ticket eligible for closing (zero, several, or only the parent issue).
- The verification command returns a list other than the expected one.
- The PR title or a commit message in the PR still carries a closing keyword and cannot be safely fixed.
- An extra entry in `closingIssuesReferences` is a manual link from the UI Development panel that cannot be unlinked in the UI.
- After removing or downgrading, re-check the commit count **first** with `gh api 'repos/{owner}/{repo}/pulls/<PR>' --jq .commits` — above 250 there is no way to check item (4), so this zero proof cannot hold and you go to the `Above 250` hard stop section below. At 250 or fewer, check all four in this order after the count: (1) direct body scan (`gh pr view <PR> --json body --jq .body`) closing keyword+issue reference = 0, (2) `closingIssuesReferences` = 0 (body links and UI Development panel manual links both 0), (3) PR title closing keyword+issue reference = 0, (4) every commit message closing keyword+issue reference = 0 — and only when all four report zero proceed to the manual-close fallback.

Run the manual close with the target issue's repository named explicitly — for a cross-repository ticket, `gh issue close <number> -R <owner>/<repo> --comment "..."`. Without `-R`, `gh` infers the repository from the current clone's remote and closes this repository's issue of the same number. In the same repository `-R` is optional and harmless either way. Read the target straight from the reference preserved on the downgraded `Refs` line — which is why a downgrade must never strip the `<owner>/<repo>` part.

## Wayfinding Operations

Used by `/vibe-deep-plan`. A **map** is a single issue with tickets as **sub-issues**.

- **Map**: Single issue labeled `상태:초안` and `유형:계획` with Notes / Decisions-so-far / Fog body: `gh issue create --label "상태:초안" --label "유형:계획"`.
- **Child Tickets**: create the issue first, then fetch its numeric database id with `gh api repos/<owner>/<repo>/issues/<child> --jq .id`. Add the GitHub native sub-issue relationship with `gh api --method POST repos/<owner>/<repo>/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>`. Immediately read `gh api repos/<owner>/<repo>/issues/<map>/sub_issues --jq 'map(.number)'` and verify that `<child>` is present. Missing relationship support in a high-level tool does not mean GitHub sub-issues are disabled; use the allowed `gh api` path. If the write or read-back cannot be performed, do not report success through a `Parent map` body line, link, or task list. Report the created-but-unlinked issue numbers and the blocked operation, then stop. Fall back to a map-body task list plus `Part of #<map>` only when the GitHub API explicitly reports that this repository does not support sub-issues. Labels: `유형:조사` / `유형:프로토타입` / `유형:인터뷰` / `유형:작업`. Assign to the acting developer upon claiming.
- **Blocking**: GitHub's **native issue dependencies** — canonical UI-rendered representation. Add edges via `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the numeric **database id** of the blocking issue (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, not `#number` or `node_id`). Open blockers appear on `gh issue list --json blockedBy` as `blockedBy` (`totalCount` / `nodes`). Do not read `issue_dependencies_summary` from list output. If `blockedBy` or native dependencies are unavailable, fall back to `Blocked by: #<n>, #<n>` lines at top of child body. A ticket unblocks when all blocking issues close.
- **Frontier Query**: Fetch open children of the map (`gh issue list --state open --json number,title,labels,blockedBy,assignees,subIssues`, restricted to map sub-issues / task list), excluding those with open blockers (`blockedBy.totalCount > 0` or nonempty `blockedBy.nodes`, or open issues in a `Blocked by` line) or assignees, ordered by map position.
- **Claim**: `gh issue edit <n> --add-assignee @me` — first record of session.
- **Release Research Claim**: After saving full findings and research record pointer during charting, run `gh issue edit <n> --remove-assignee @me`. Leave research issue open without adding map gist. Retain assignee if save fails or session passes incomplete work.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, and append context pointer (gist + link) to map's Decisions-so-far.

## Research Record Persistence

- Calling session posts full findings with source citations in a single dedicated comment on the same research issue, starting with `<!-- vibe-deep-plan research: <map-issue>/<ticket-issue> -->` for immutable identity lookup.
- If comments exceed GitHub limits, use ordered comments (`Research record 1/N`, `2/N`...) or repo-owned wikis, snippets, attachments, or equivalent persistent artifacts, linking that record from the issue comment. Never truncate findings or leave only in local files.
- Record `Research record: <comment or artifact URL>` on ticket. Hosted research has no `Branch`, `Commit`, or `Path` pointers, and never creates or pushes `research/...` branches.
- Keep research issues open during charting without map gists. Release claim after successful save with `gh issue edit <n> --remove-assignee @me`. Retain claim if save fails. Inspect existing comments and linked artifacts before re-running.
