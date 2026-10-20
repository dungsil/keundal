import { ref } from 'vue'
import { expect, test, vi } from 'vitest'
import { createModelSelection } from '../shared/utils/model-selection'
import { DEFAULT_MODEL_KEY, FALLBACK_MODEL } from '../shared/utils/model-preferences'

function fixture(options: { selectModel?: (value: string) => Promise<void>, available?: string[] } = {}) {
  const model = ref(FALLBACK_MODEL)
  const defaultModel = ref('')
  const switching = ref(false)
  const error = ref('')
  const values = new Map<string, string>()
  const setItem = vi.fn((key: string, value: string) => {
    values.set(key, value)
  })
  const selection = createModelSelection({
    model,
    defaultModel,
    switching,
    error,
    storage: { setItem, removeItem: key => values.delete(key) },
    selectModel: options.selectModel,
    canSelectDefault: value => !options.available || options.available.includes(value),
    onError: () => { error.value = 'model.switchFailed' }
  })
  return { ...selection, model, defaultModel, switching, error, values, setItem }
}

test('기본 모델을 저장해도 현재 선택은 바꾸지 않고 새 대화에서 기본 모델을 적용한다', () => {
  const models = fixture()
  models.selectedModel.value = 'openai/current'
  models.saveDefaultModel('google/default')
  expect(models.model.value).toBe('openai/current')
  models.applyDefaultModel()
  expect(models.model.value).toBe('google/default')
  models.selectedModel.value = 'openai/temporary'
  expect(models.defaultModel.value).toBe('google/default')
  expect(models.values.get(DEFAULT_MODEL_KEY)).toBe('google/default')
  models.applyDefaultModel()
  expect(models.model.value).toBe('google/default')
  models.saveDefaultModel('')
  models.selectedModel.value = 'openai/last'
  models.applyDefaultModel()
  expect(models.model.value).toBe('openai/last')
})

test('기본 모델 저장이 실패하면 메모리의 기존 기본 모델을 유지한다', () => {
  const models = fixture()
  models.saveDefaultModel('openai/default')
  models.setItem.mockImplementationOnce(() => {
    throw new Error('Storage full')
  })
  expect(() => models.saveDefaultModel('google/replacement')).toThrow('Storage full')
  expect(models.defaultModel.value).toBe('openai/default')
})

test('데스크톱은 기본 모델 전환이 성공한 뒤 선택을 바꾸고 실패하면 기존 선택을 유지한다', async () => {
  const selectModel = vi.fn().mockResolvedValue(undefined)
  const models = fixture({ selectModel })
  const previous = models.model.value
  models.saveDefaultModel('openai/default')
  models.applyDefaultModel()
  expect(models.switching.value).toBe(true)
  expect(models.model.value).toBe(previous)
  await vi.waitFor(() => expect(models.switching.value).toBe(false))
  expect(selectModel).toHaveBeenCalledWith('openai/default')
  expect(models.model.value).toBe('openai/default')
  selectModel.mockRejectedValueOnce(new Error('Sidecar failed'))
  models.saveDefaultModel('google/default')
  models.applyDefaultModel()
  await vi.waitFor(() => expect(models.switching.value).toBe(false))
  expect(models.model.value).toBe('openai/default')
  expect(models.error.value).toBe('model.switchFailed')
})

test('원격 호스트에 없는 기본 모델은 보존하고 현재 사용 가능한 선택을 유지한다', () => {
  const models = fixture({ available: ['openai/host'] })
  models.selectedModel.value = 'openai/host'
  models.saveDefaultModel('google/unavailable')
  models.applyDefaultModel()
  expect(models.model.value).toBe('openai/host')
  expect(models.defaultModel.value).toBe('google/unavailable')
})
