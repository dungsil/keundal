import { Context } from 'cordis'
import { ref } from 'vue'
import { expect, test } from 'vitest'
import { ChatRuntime } from '@keundal/ui-runtime'

test('실행 정책을 검증해 저장하고 초안 변경과 저장 실패로부터 적용 값을 보존한다', async (t) => {
  const values = new Map<string, string>()
  let fail = false
  const ctx = new Context()
  const plugin = await ctx.plugin(ChatRuntime, {
    capabilities: { secureSettings: false, localSkills: false },
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (fail) throw new Error('Storage full')
        values.set(key, value)
      },
      removeItem: (key: string) => {
        if (fail) throw new Error('Storage full')
        values.delete(key)
      }
    } as Storage,
    preferences: { webSearch: ref(true), reasoning: ref<'medium'>('medium') },
    openProviderSettings: () => {}, notifyError: () => {},
    messages: { modelsLoadFailed: () => '', modelSwitchFailed: () => '' }
  })
  t.onTestFinished(() => plugin.dispose())
  const budget = { maxTokens: 12345, maxCost: { amount: 0, currency: 'USD' }, maxDurationMs: 1250 }
  ctx.chatRuntime.saveRunBudget(budget)
  budget.maxCost.amount = 99
  expect(ctx.chatRuntime.runBudget.value).toEqual({
    maxTokens: 12345, maxCost: { amount: 0, currency: 'USD' }, maxDurationMs: 1250, unknownPricing: 'reject'
  })
  expect(JSON.parse(values.get('keundal:run-budget')!)).toEqual(ctx.chatRuntime.runBudget.value)
  expect(() => ctx.chatRuntime.saveRunBudget({ maxTokens: 1.5 })).toThrow()
  expect(ctx.chatRuntime.runBudget.value?.maxTokens).toBe(12345)

  const role = { name: 'reviewer', description: 'Review', instructions: 'Check changes', model: 'openai/reviewer', allowedTools: ['read_file'], maxToolRounds: 3 }
  ctx.chatRuntime.saveSubagentRoles([role])
  role.allowedTools.push('write_file')
  expect(ctx.chatRuntime.subagentRoles.value[0]?.allowedTools).toEqual(['read_file'])
  ctx.chatRuntime.saveSubagentRoles([{ ...role, allowedTools: [] }])
  expect(ctx.chatRuntime.subagentRoles.value[0]?.allowedTools).toEqual([])

  fail = true
  expect(() => ctx.chatRuntime.saveRunBudget(undefined)).toThrow('Storage full')
  expect(() => ctx.chatRuntime.saveRunBudget({ maxTokens: 20 })).toThrow('Storage full')
  expect(ctx.chatRuntime.runBudget.value?.maxTokens).toBe(12345)
  fail = false
  ctx.chatRuntime.saveRunBudget(undefined)
  expect(ctx.chatRuntime.runBudget.value).toBeUndefined()
  expect(values.has('keundal:run-budget')).toBe(false)
})
