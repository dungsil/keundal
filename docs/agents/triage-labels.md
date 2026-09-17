# Labels

Skills speak in terms of canonical roles. This file maps those roles to actual label strings used in this repository's issue tracker.

## Triage Status Roles

Five states incoming requests move through, used in the triage stage of `vibe-plan`.

| Canonical Role    | Tracker Label       | Meaning                                                  |
| ----------------- | ------------------- | -------------------------------------------------------- |
| `needs-triage`    | `상태:분류필요`     | Maintainer must evaluate this issue                      |
| `needs-info`      | `상태:정보필요`     | Awaiting additional info from reporter                   |
| `ready-for-agent` | `상태:에이전트작업` | Spec is complete and ready for AFK agent implementation  |
| `ready-for-human` | `상태:사람작업`     | Must be implemented by a human directly                 |
| `wontfix`         | `상태:처리안함`     | Will not be addressed                                    |

When a skill mentions a role (e.g. "apply the ready-for-agent triage label"), use the corresponding label string from this table.

Edit the right column to match the vocabulary actually used in your tracker.

## Planning Labels

Used by `vibe-plan` and `vibe-deep-plan` to mark planning artifacts. The plan type marks hosted spec/plan issues and decision maps. Map status marks an effort index as in progress, while decision types record how child tickets get resolved.

| Canonical Role | Tracker Label    | Meaning                                                             |
| -------------- | ---------------- | ------------------------------------------------------------------- |
| plan           | `유형:계획`       | Parent planning artifact: a spec/plan issue or decision map         |
| map            | `상태:초안`       | This issue is a decision map — index of effort, not actionable task |
| research       | `유형:조사`       | Resolved by background subagent reading primary sources             |
| prototype      | `유형:프로토타입` | Resolved by throwaway artifact to gauge reactions                   |
| grilling       | `유형:인터뷰`     | Resolved by dialogue asking one question at a time                  |
| task           | `유형:작업`       | Manual prerequisite work that must precede decisions                |

## Two Axes

`상태:` answers "what state is this in", while `유형:` answers "what planning artifact is this, or how does this decision resolve". An issue carries **at most one label per axis**.

A hosted spec/plan issue carries `유형:계획` together with the appropriate triage status. A decision map carries `유형:계획` together with `상태:초안`. Because `상태:초안` shares the state axis with triage statuses, a map does not carry a triage status. Decision tickets on the map carry one of the four decision `유형:` labels and no triage status. Triage statuses apply to implementation tickets only after the map finishes and `vibe-plan` publishes them. Skills speak in canonical roles; the right column of the tables above is the only label vocabulary. Do not translate those strings into English (`status:draft`, `type:plan`, `type:research`, …).
