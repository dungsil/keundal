import { expect, test } from 'vitest'
import { DEFAULT_MODEL_KEY, MODEL_KEY, TITLE_MODEL_KEY, readModelPreference, saveTitleModel, loadModelPreferences, saveDefaultModel } from '@keundal/chat/model-preferences'
import { MODEL_RECOVERY_KEY, loadModelRecovery, saveModelRecovery } from '@keundal/chat/model-preferences'

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
}

test('기본 모델을 저장하면 마지막 선택보다 우선하고 해제하면 마지막 선택을 복원한다', () => {
  const saved = storage()
  saved.setItem(MODEL_KEY, 'openai/gpt-custom')
  expect(loadModelPreferences(saved)).toEqual({ defaultModel: '', model: 'openai/gpt-custom' })
  saveDefaultModel(saved, 'anthropic/claude-haiku-4.5')
  expect(loadModelPreferences(saved)).toEqual({ defaultModel: 'anthropic/claude-haiku-4-5', model: 'anthropic/claude-haiku-4-5' })
  saveDefaultModel(saved, '')
  expect(saved.values.has(DEFAULT_MODEL_KEY)).toBe(false)
  expect(loadModelPreferences(saved)).toEqual({ defaultModel: '', model: 'openai/gpt-custom' })
})

test('손상된 기본 모델과 접근할 수 없는 저장소는 시작을 막지 않는다', () => {
  const saved = storage()
  saved.setItem(DEFAULT_MODEL_KEY, 'unknown/model')
  saved.setItem(MODEL_KEY, 'google/gemini-3-flash')
  expect(loadModelPreferences(saved)).toEqual({ defaultModel: '', model: 'google/gemini-3-flash-preview' })
  expect(loadModelPreferences({ getItem: () => {
    throw new Error('Storage denied')
  } }))
    .toEqual({ defaultModel: '', model: undefined })
})

test('잘못된 기본 모델은 기존 선택을 덮어쓰지 않는다', () => {
  const saved = storage()
  saveDefaultModel(saved, 'openai/custom/model')
  expect(() => saveDefaultModel(saved, 'openai/')).toThrow()
  expect(loadModelPreferences(saved).defaultModel).toBe('openai/custom/model')
})

test('추가 공급자의 기본 모델을 저장하고 공급자 식별자와 모델 경로를 그대로 복원한다', () => {
  const saved = storage()
  saveDefaultModel(saved, 'openai@work/vendor/model')
  expect(loadModelPreferences(saved)).toEqual({ defaultModel: 'openai@work/vendor/model', model: 'openai@work/vendor/model' })
})

test('제목 모델은 채팅 기본 모델과 독립적으로 저장하고 해제한다', () => {
  const saved = storage()
  saveDefaultModel(saved, 'openai/chat')
  saveTitleModel(saved, 'anthropic/claude-haiku-4.5')
  expect(readModelPreference(saved, TITLE_MODEL_KEY)).toBe('anthropic/claude-haiku-4-5')
  expect(loadModelPreferences(saved).defaultModel).toBe('openai/chat')
  expect(() => saveTitleModel(saved, 'unknown/title')).toThrow()
  expect(readModelPreference(saved, TITLE_MODEL_KEY)).toBe('anthropic/claude-haiku-4-5')
  saveTitleModel(saved, '')
  expect(readModelPreference(saved, TITLE_MODEL_KEY)).toBeUndefined()
  expect(loadModelPreferences(saved).defaultModel).toBe('openai/chat')
})

test('대체 모델 순서와 재시도 정책을 저장·복원하고 잘못된 정책은 기존 값을 보존한다', () => {
  const saved = storage()
  expect(loadModelRecovery(saved)).toBeUndefined()
  const policy = { retry: { maxRetries: 1, initialDelayMs: 30, maxDelayMs: 90 }, fallbackModels: ['openai@work/vendor/model', 'anthropic/claude-haiku-4.5'] }
  saveModelRecovery(saved, policy)
  expect(loadModelRecovery(saved)).toEqual({ ...policy, fallbackModels: ['openai@work/vendor/model', 'anthropic/claude-haiku-4-5'] })
  const previous = saved.getItem(MODEL_RECOVERY_KEY)
  for (const invalid of [
    { ...policy, retry: { maxRetries: 6 } },
    { ...policy, retry: { initialDelayMs: 91, maxDelayMs: 90 } },
    { ...policy, retry: { maxRetries: 1.5 } },
    { ...policy, fallbackModels: ['openai/a', 'openai/a'] },
    { ...policy, fallbackModels: ['anthropic/claude-haiku-4.5', 'anthropic/claude-haiku-4-5'] },
    { ...policy, fallbackModels: Array.from({ length: 9 }, (_, i) => `openai/${i}`) }
  ]) {
    expect(() => saveModelRecovery(saved, invalid)).toThrow()
    expect(saved.getItem(MODEL_RECOVERY_KEY)).toBe(previous)
  }
  saveModelRecovery(saved, { retry: false, fallbackModels: [] })
  expect(loadModelRecovery(saved)).toEqual({ retry: false, fallbackModels: [] })
  saved.setItem(MODEL_RECOVERY_KEY, '{broken')
  expect(loadModelRecovery(saved)).toBeUndefined()
})
