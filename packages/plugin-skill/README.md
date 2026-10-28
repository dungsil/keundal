# @keundal/plugin-skill

등록한 공급자의 스킬 목록을 합쳐 `ctx.skills`로 제공합니다. 목록에는 이름과 설명만 포함하며, 본문은 `load()`를 호출할 때 불러옵니다.

## 등록과 사용

```ts
import skillPlugin from '@keundal/plugin-skill'

await ctx.plugin(skillPlugin, {
  providers: [
    {
      name: 'bundled',
      async prepare({ signal } = {}) {
        signal?.throwIfAborted()
        return {
          skills: [{ name: 'review', description: '변경 사항을 검토한다.' }],
          async load(name, { signal } = {}) {
            signal?.throwIfAborted()
            if (name !== 'review') return undefined
            return {
              name,
              description: '변경 사항을 검토한다.',
              content: '공개 인터페이스와 오류 경로를 검토한다.'
            }
          }
        }
      }
    }
  ]
})

const catalog = await ctx.skills.prepare({ signal })
const definition = await catalog.load('review', { signal })
```

파일을 사용하려면 [파일시스템 공급자](../plugin-skill-filesystem/README.md)를 등록합니다. 모델 연결은 [에이전트의 스킬 설정](../agent/README.md#스킬-사용)을 사용합니다.

## 보조 자료 계약

보조 자료를 제공하는 공급자는 `SkillDefinition.resources`에 스킬 상대 경로 목록을 넣고, `SkillCatalog.readResource(name, path, options)`로 요청한 파일의 텍스트를 반환합니다. 둘 다 선택 사항이므로 기존 본문 전용 공급자는 그대로 사용할 수 있습니다.

경로는 `references/`, `assets/`, `scripts/` 아래로 제한합니다. 레지스트리는 경로 형식과 공급자 선택을 검사하며, 실제 파일 경계·형식·크기는 공급자가 검사합니다. 보조 자료도 본문과 같은 공급자에서 읽으며 읽기 실패 시 다른 공급자로 전환하지 않습니다. 취소와 공급자 해제 규칙도 같습니다.

`skill` 도구는 `name`만 받으면 지침과 파일 목록을 반환하고, `path`도 받으면 해당 보조 자료만 반환합니다. 읽기는 스크립트 실행이나 실행 권한을 제공하지 않습니다. [Agent Plugins](../agent-plugins/README.md#스킬-보조-자료)는 호스트와 브라우저에서 이 계약을 구현합니다.

## 선택과 오류

- 목록은 이름순으로 정렬합니다. 동명 스킬은 먼저 등록한 공급자가 제공합니다.
- 같은 공급자 이름의 중복 등록은 거부합니다. 한 공급자가 같은 스킬 이름을 두 번 이상 반환해도 오류가 발생합니다.
- `prepare()`는 목록과 이름별 공급자 선택을 고정합니다. 이후 등록한 스킬은 다음 목록부터 반영합니다.
- 본문은 고정하지 않습니다. 선택한 공급자의 `load()`가 호출 시점의 내용을 반환할 수 있습니다.
- 선택한 공급자를 해제하거나 본문이 사라지면 이전 목록의 로딩은 실패합니다. 다른 공급자의 동명 스킬로 전환하지 않습니다.
- 목록에 없는 이름은 `undefined`를 반환합니다. 공급자 조회 실패와 잘못된 정의는 오류로 전달합니다.
- 공급자 하나라도 실패하면 목록 조회가 실패합니다. 마지막 정상 목록을 대신 반환하지 않습니다.

스킬 이름은 `^[a-z0-9]+(?:-[a-z0-9]+)*$`를 따릅니다. 설명과 본문은 비어 있지 않은 문자열이어야 합니다.

## 공급자 수명

`SkillProvider`는 `@keundal/skill`에서 가져옵니다. 공급자는 `prepare(options)`에서 `SkillCatalog`를 반환합니다.

추가 공급자는 `ctx.skills.registerProvider(provider)`로 등록합니다. 반환한 함수를 호출하면 등록을 해제하고 진행 중 작업의 신호를 취소합니다.

공급자 플러그인은 자신의 수명에 등록 해제를 연결합니다.

```ts
ctx.fiber.effect(() => ctx.skills.registerProvider(provider))
```

호출 취소, 공급자 해제, 서비스 해제는 공급자에 전달하는 신호를 취소합니다. 공급자는 전달받은 신호를 실제 작업에 연결해야 합니다.

레지스트리는 스킬 본문을 실행하거나 세션을 변경하지 않습니다. 신뢰할 수 있는 공급자만 등록합니다.
