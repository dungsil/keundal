import type { SkillDefinition, SkillProvider } from '@keundal/core'
import skillPlugin from '@keundal/plugin-skill'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

const definition = (name: string, content = name): SkillDefinition => ({ name, description: `Use ${name}`, content })
const provider = (name: string, definitions: SkillDefinition[]): SkillProvider => ({
  name,
  async prepare() {
    return {
      skills: definitions.map(({ name, description }) => ({ name, description })),
      async load(name) {
        return definitions.find((skill) => skill.name === name)
      }
    }
  }
})
async function setup(t: TestContext, providers: SkillProvider[] = []) {
  const ctx = new Context()
  const plugin = await ctx.plugin(skillPlugin, { providers })
  t.onTestFinished(() => plugin.dispose())
  return { ctx, plugin }
}

test('목록을 이름순으로 정렬하고 먼저 등록한 공급자의 본문을 선택한다', async (t) => {
  const { ctx } = await setup(t, [
    provider('first', [definition('zeta'), definition('review', 'first body')]),
    provider('second', [definition('alpha'), definition('review', 'second body')])
  ])
  const catalog = await ctx.skills.prepare()
  expect(catalog.skills).toEqual([
    { name: 'alpha', description: 'Use alpha' },
    { name: 'review', description: 'Use review' },
    { name: 'zeta', description: 'Use zeta' }
  ])
  ctx.skills.registerProvider(provider('later', [definition('new-skill')]))
  expect(await catalog.load('review')).toEqual(definition('review', 'first body'))
  expect(await catalog.load('new-skill')).toBeUndefined()
  expect((await ctx.skills.prepare()).skills.map((skill) => skill.name)).toContain('new-skill')
})

test('선택한 공급자를 해제하면 이전 목록은 동명 스킬로 전환하지 않는다', async (t) => {
  const { ctx } = await setup(t)
  const dispose = ctx.skills.registerProvider(provider('first', [definition('review', 'first')]))
  ctx.skills.registerProvider(provider('second', [definition('review', 'second')]))
  const catalog = await ctx.skills.prepare()
  dispose()
  ctx.skills.registerProvider(provider('first', [definition('review', 'replacement')]))
  dispose()
  await expect(catalog.load('review')).rejects.toThrow('skill provider disposed')
  expect(await (await ctx.skills.prepare()).load('review')).toEqual(definition('review', 'second'))
})

test('공급자 내부의 중복 이름과 목록 조회 실패를 숨기지 않는다', async (t) => {
  const { ctx } = await setup(t)
  const dispose = ctx.skills.registerProvider(provider('duplicate', [definition('review'), definition('review')]))
  await expect(ctx.skills.prepare()).rejects.toThrow('duplicate skill name')
  dispose()
  ctx.skills.registerProvider({
    name: 'broken',
    async prepare() {
      throw new Error('offline')
    }
  })
  await expect(ctx.skills.prepare()).rejects.toThrow('offline')
})

test('호출 취소와 서비스 해제를 준비된 본문 로딩에 전달한다', async (t) => {
  const { ctx, plugin } = await setup(t, [provider('local', [definition('review')])])
  const controller = new AbortController()
  const catalog = await ctx.skills.prepare({ signal: controller.signal })
  controller.abort(new Error('cancel lookup'))
  await expect(catalog.load('review')).rejects.toThrow('cancel lookup')
  const another = await ctx.skills.prepare()
  await plugin.dispose()
  await expect(another.load('review')).rejects.toThrow('skill service disposed')
})
