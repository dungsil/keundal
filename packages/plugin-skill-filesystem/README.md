# @keundal/plugin-skill-filesystem

지정한 루트의 바로 아래 디렉터리에서 `SKILL.md`를 발견하고 `ctx.skills`에 등록합니다. 기본 진입점은 Node.js 파일시스템을 사용합니다. Markdown 파서 진입점은 브라우저에서도 실행합니다.

## 설정

```ts
import skillPlugin from '@keundal/plugin-skill'
import filesystemSkillPlugin from '@keundal/plugin-skill-filesystem'

await ctx.plugin(skillPlugin)
await ctx.plugin(filesystemSkillPlugin, {
  roots: ['./skills'],
  name: 'project-skills'
})
```

`roots`는 비어 있지 않은 경로 배열입니다. 상대 경로는 공급자를 만들 때 현재 작업 디렉터리를 기준으로 확정합니다. `name`의 기본값은 `filesystem`입니다.

루트는 이미 존재해야 합니다. 홈 디렉터리와 프로젝트 디렉터리를 자동으로 탐색하지 않습니다. 같은 공급자의 루트 간에 이름이 중복되면 오류가 발생합니다.

별도 플러그인 대신 `createFilesystemSkillProvider(config)`로 공급자를 만들어 레지스트리에 등록할 수도 있습니다.

## Markdown 파서

파일 접근 없이 문자열을 검증하려면 별도 진입점을 사용합니다. Node.js 파일시스템 모듈을 가져오지 않으며 `SkillDefinition`을 반환합니다. 잘못된 frontmatter나 빈 본문은 예외로 알립니다.

```ts
import { parseSkillMarkdown } from '@keundal/plugin-skill-filesystem/markdown'

const definition = parseSkillMarkdown(markdown)
```

## 파일 형식

```text
skills/
└── review/
    ├── SKILL.md
    └── references/
        └── checklist.md
```

`SKILL.md`에는 YAML frontmatter와 Markdown 본문을 작성합니다.

```markdown
---
name: review
description: 변경 사항을 검토하고 회귀 위험을 찾는다.
---

# Review

공개 인터페이스와 오류 경로를 검토한다.
```

- `name`과 `description`은 필수입니다. 본문도 비어 있으면 안 됩니다.
- `name`은 소문자 영문과 숫자를 사용하며 단어 사이에 하이픈을 허용합니다.
- 디렉터리 이름이 아니라 frontmatter의 `name`을 식별자로 사용합니다.
- 루트 바로 아래의 `<directory>/SKILL.md`만 탐색합니다. 중첩 디렉터리, 단독 Markdown 파일, 디렉터리 심볼릭 링크는 탐색하지 않습니다.
- 잘못된 파일은 경로와 이유를 포함한 오류로 보고합니다.

## 로딩과 제한

목록을 준비할 때 파일을 읽어 형식을 검증하지만, 목록에는 본문을 포함하지 않습니다. `load()`는 선택한 파일을 다시 읽습니다.

본문 수정은 다음 로딩에 반영됩니다. 이름이 변경되거나 파일이 사라지면 이전 목록의 로딩은 실패합니다. 파일 감시는 하지 않으며 다음 `prepare()`에서 목록을 새로 읽습니다.

본문을 불러와도 스크립트와 첨부 파일을 실행하거나 읽지 않습니다. 상대 경로 리소스 접근을 보장하지 않습니다. 신뢰할 수 있는 파일만 등록합니다.

플러그인을 해제하면 공급자 등록을 제거하고 해당 공급자의 진행 중 작업을 취소합니다.
