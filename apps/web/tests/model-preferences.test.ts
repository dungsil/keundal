import { expect, test } from 'vitest'
import { DEFAULT_MODEL_KEY, MODEL_KEY, loadModelPreferences, saveDefaultModel } from '../shared/utils/model-preferences'

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
