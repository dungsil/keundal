import { createNativeSkillSource } from '@keundal/plugin-chat-desktop/skills'
import { mountAgent } from './fixtures/agent'
import type { invoke } from '@tauri-apps/api/core'
import { Context } from 'cordis'
import { EventType } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import skillPlugin from '@keundal/plugin-skill'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { expect, test, type TestContext } from 'vitest'
import { SKILL_SETTINGS_KEY } from '@keundal/chat/skills'
import { SkillManager } from '@keundal/plugin-chat-browser/skills'
import { createKeundalChat } from '@keundal/plugin-chat-local/keundal'

const review = { name: 'review', description: 'Review code', content: 'Check public behavior.', enabled: true }
const markdown = (name: string, body: string) => `---\nname: ${name}\ndescription: Review code\n---\n${body}`
function storage() {
  const saved = new Map<string, string>()
  return {
    saved,
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value) }
  }
}
async function registry(t: TestContext, manager: SkillManager) {
  const ctx = new Context()
  const plugin = await ctx.plugin(skillPlugin, { providers: manager.providers })
  t.onTestFinished(() => plugin.dispose())
  return ctx
}

test('저장한 스킬의 생성·수정·사용 중지·삭제는 다음 목록에 반영하고 기존 목록은 보존한다', async (t) => {
  const local = storage()
  const manager = new SkillManager(local)
  expect(manager.load().skills).toEqual([])
  manager.save({ ...manager.load(), skills: [review] })
  const ctx = await registry(t, manager)
  const original = await ctx.skills.prepare()
  const reloaded = new SkillManager(local)
  reloaded.save({ ...reloaded.load(), skills: [{ ...review, content: 'Changed instructions.' }] })
  expect((await (await ctx.skills.prepare()).load('review'))?.content).toBe('Changed instructions.')
  expect((await original.load('review'))?.content).toBe(review.content)
  manager.save({ ...manager.load(), skills: [{ ...review, enabled: false }] })
  expect((await ctx.skills.prepare()).skills).toEqual([])
  manager.save({ ...manager.load(), skills: [] })
  expect(new SkillManager(local).load().skills).toEqual([])
})

test('잘못된 정의와 중복 이름을 저장하지 않고 저장 실패 시 이전 설정을 보존한다', () => {
  const local = storage()
  const manager = new SkillManager(local)
  manager.save({ ...manager.load(), skills: [review] })
  const previous = local.saved.get(SKILL_SETTINGS_KEY)
  expect(() => manager.save({ ...manager.load(), skills: [review, review] })).toThrow('Duplicate skill name')
  expect(() => manager.save({ ...manager.load(), skills: [{ ...review, name: '../escape' }] })).toThrow()
  expect(local.saved.get(SKILL_SETTINGS_KEY)).toBe(previous)
  const unavailable = new SkillManager({
    getItem: local.getItem,
    setItem() {
      throw new Error('Storage full')
    }
  })
  expect(() => unavailable.save({ ...manager.load(), skills: [] })).toThrow('Storage full')
  expect(manager.load().skills).toEqual([review])
})

test('데스크톱은 저장한 스킬·실행 디렉터리·홈 순서로 선택하고 파일 사용 중지를 보존한다', async (t) => {
  const local = storage()
  const project = '/project/.agents/skills'
  const home = '/home/person/.agents/skills'
  const files = [
    { root: project, path: `${project}/review/SKILL.md`, markdown: markdown('review', 'Project body') },
    { root: home, path: `${home}/review/SKILL.md`, markdown: markdown('review', 'Home body') }
  ]
  const native: typeof invoke = async <T>(command: string, args?: Parameters<typeof invoke>[1]) => {
    if (command === 'list_skill_files') return { roots: [project, home], files } as T
    if (command === 'read_skill_file') return files.find(file => file.path === (args as { path: string }).path)!.markdown as T
    throw new Error('Unknown command')
  }
  const manager = new SkillManager(local, createNativeSkillSource(native))
  manager.save({ ...manager.load(), skills: [review] })
  const ctx = await registry(t, manager)
  expect((await (await ctx.skills.prepare()).load('review'))?.content).toBe(review.content)
  manager.save({ ...manager.load(), skills: [] })
  const catalog = await ctx.skills.prepare()
  expect(catalog.skills).toEqual([{ name: 'review', description: review.description }])
  files[0]!.markdown = markdown('review', 'Fresh project body')
  expect((await catalog.load('review'))?.content).toBe('Fresh project body')
  manager.save({ ...manager.load(), disabledFiles: [files[0]!.path] })
  expect((await (await ctx.skills.prepare()).load('review'))?.content).toBe('Home body')
  files[0]!.markdown = markdown('renamed', 'Renamed body')
  await expect(catalog.load('review')).rejects.toThrow('Skill name changed')
  manager.save({ ...manager.load(), loadLocal: false })
  expect((await ctx.skills.prepare()).skills).toEqual([])
  expect(new SkillManager(local, createNativeSkillSource(native)).load()).toMatchObject({ loadLocal: false, disabledFiles: [files[0]!.path] })
})

test('잘못된 파일을 경로와 함께 표시하고 해당 파일을 끄면 다른 스킬을 사용한다', async (t) => {
  const path = '/home/person/.agents/skills/broken/SKILL.md'
  const native: typeof invoke = async <T>() => ({ roots: [], files: [{ root: '/home/person/.agents/skills', path, markdown: 'Invalid frontmatter' }] }) as T
  const manager = new SkillManager(storage(), createNativeSkillSource(native))
  expect((await manager.listFiles()).files[0]).toMatchObject({ path, error: 'YAML frontmatter is required' })
  const ctx = await registry(t, manager)
  await expect(ctx.skills.prepare()).rejects.toThrow(path)
  manager.save({ ...manager.load(), disabledFiles: [path], skills: [review] })
  expect((await (await ctx.skills.prepare()).load('review'))?.content).toBe(review.content)
})

test('취소된 네이티브 로딩은 본문을 모델에 전달하지 않는다', async (t) => {
  const pending = Promise.withResolvers<string>()
  const started = Promise.withResolvers<undefined>()
  const native: typeof invoke = async <T>(command: string) => {
    if (command === 'list_skill_files') return { roots: [], files: [{ root: '/skills', path: '/skills/review/SKILL.md', markdown: markdown('review', 'Initial body') }] } as T
    started.resolve(undefined)
    return await pending.promise as T
  }
  const ctx = await registry(t, new SkillManager(storage(), createNativeSkillSource(native)))
  const catalog = await ctx.skills.prepare()
  const controller = new AbortController()
  const task = catalog.load('review', { signal: controller.signal })
  const rejected = expect(task).rejects.toThrow('Stopped')
  await started.promise
  controller.abort(new Error('Stopped'))
  pending.resolve(markdown('review', 'Do not deliver this body'))
  await rejected
})

test('웹 대화의 에이전트는 저장한 스킬을 발견하고 도구 결과로 불러온다', async (t) => {
  const manager = new SkillManager(storage())
  manager.save({ ...manager.load(), skills: [review, { ...review, name: 'disabled', enabled: false }] })
  const ctx = await registry(t, manager)
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push(structuredClone(request))
      if (requests.length === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'load', toolCallName: 'skill' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'load', delta: '{"name":"review"}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'load' }
      } else {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Reviewed' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const runtime = await createKeundalChat(ctx, 'openai/gpt-5-nano', {}, mountAgent)
  t.onTestFinished(() => runtime.dispose())
  const events = []
  for await (const event of runtime.respond({ threadId: 'chat', instructions: 'Be helpful.', messages: [{ id: 'question', role: 'user', parts: [{ type: 'text', text: 'Review my code.' }] }] })) events.push(event)
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: EventType.RUN_FINISHED })
  expect(requests[0]!.input.messages).toContainEqual(expect.objectContaining({ role: 'system', content: expect.stringContaining('review: Review code') }))
  expect(JSON.stringify(requests[0])).not.toContain('Check public behavior.')
  expect(JSON.stringify(requests[0])).not.toContain('- disabled:')
  expect(requests[1]!.input.messages).toContainEqual(expect.objectContaining({ role: 'tool', content: '<skill_content name="review">\nCheck public behavior.\n</skill_content>' }))
})
