import { loadPromptPresets, parsePromptPresetSettings, PROMPT_PRESETS_KEY } from '@keundal/chat'
import { Context } from 'cordis'
import { ref } from 'vue'
import { expect, test, vi } from 'vitest'
import { ChatRuntime } from '@keundal/ui-runtime'

test('기존 사용자 지침을 보존해 기본 프리셋으로 읽고 새 저장 값이 있으면 이를 우선한다', () => {
  const values = new Map([['keundal:system-prompt', '  Answer in Korean.  ']])
  const storage = { getItem: (key: string) => values.get(key) ?? null }
  const settings = loadPromptPresets(storage)
  expect(settings.activePresetId).toBe('default')
  expect(settings.presets[0]?.blocks).toEqual([
    { id: 'instructions', type: 'text', name: 'Instructions', enabled: true, role: 'system', content: 'Answer in Korean.' },
    { id: 'history', type: 'history', name: 'History', enabled: true }
  ])
  expect(values.get('keundal:system-prompt')).toBe('  Answer in Korean.  ')
  values.set(PROMPT_PRESETS_KEY, JSON.stringify({ activePresetId: null, presets: [] }))
  expect(loadPromptPresets(storage)).toEqual({ activePresetId: null, presets: [] })
})

test('중복 ID와 존재하지 않는 선택 및 손상된 저장 값을 조용히 덮어쓰지 않는다', () => {
  const settings = loadPromptPresets({ getItem: () => null })
  expect(() => parsePromptPresetSettings({ ...settings, activePresetId: 'missing' })).toThrow()
  const legacy = loadPromptPresets({ getItem: (key) => key === 'keundal:system-prompt' ? 'Use Korean' : null })
  expect(() => parsePromptPresetSettings({ ...legacy, presets: [...legacy.presets, ...legacy.presets] })).toThrow()
  expect(() => loadPromptPresets({ getItem: () => '{broken' })).toThrow()
})

test('프리셋 저장에 실패하면 적용 중인 설정을 유지하고 저장 후 초안 변경과 분리한다', async (t) => {
  const setItem = vi.fn()
  const ctx = new Context()
  const plugin = await ctx.plugin(ChatRuntime, {
    capabilities: { secureSettings: false, localSkills: false },
    storage: { getItem: () => null, setItem, removeItem: () => {} } as unknown as Storage,
    preferences: { webSearch: ref(true), reasoning: ref<'medium'>('medium') },
    openProviderSettings: () => {}, notifyError: () => {},
    messages: { modelsLoadFailed: () => '', modelSwitchFailed: () => '' }
  })
  t.onTestFinished(() => plugin.dispose())
  const settings = loadPromptPresets({ getItem: (key) => key === 'keundal:system-prompt' ? 'Original' : null })
  ctx.chatRuntime.savePromptPresets(settings)
  settings.presets[0]!.name = 'Unsaved'
  expect(ctx.chatRuntime.promptPreset.value?.name).toBe('Default')
  setItem.mockImplementationOnce(() => { throw new Error('Storage full') })
  expect(() => ctx.chatRuntime.savePromptPresets({ activePresetId: null, presets: [] })).toThrow('Storage full')
  expect(ctx.chatRuntime.promptPreset.value?.name).toBe('Default')
})
