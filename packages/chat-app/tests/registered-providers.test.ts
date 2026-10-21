import { expect, test } from 'vitest'
import { defaultLLMSettings, llmSettingsSchema, registeredProviders } from '../shared/utils/llm-settings'

test('설정하지 않은 기본 공급자는 등록 목록에 표시하지 않는다', () => {
  expect(registeredProviders(defaultLLMSettings())).toEqual([])
  expect(registeredProviders(llmSettingsSchema.parse({ openai: { apiKey: '', baseURL: '', headers: {} } }))).toEqual([])
})

test('기존 키·주소·헤더 설정은 등록 목록에 유지하고 빈 기본 항목은 제외한다', () => {
  const settings = defaultLLMSettings()
  settings.openai.apiKey = 'saved-key'
  expect(registeredProviders(settings).map(item => item.id)).toEqual(['openai'])
  settings.google.baseURL = 'http://localhost:8080'
  settings.anthropic.headers = { 'x-api-key': 'saved-header' }
  expect(registeredProviders(settings).map(item => item.id)).toEqual(['anthropic', 'google', 'openai'])
})

test('명시적으로 추가한 공급자는 인증이 없어도 표시하고 삭제하면 빈 목록을 반환한다', () => {
  const settings = defaultLLMSettings()
  settings['openai@local'] = { name: 'Local', apiKey: '', baseURL: '' }
  expect(registeredProviders(settings)).toMatchObject([{ id: 'openai@local', label: 'Local', providerType: 'openai' }])
  delete settings['openai@local']
  expect(registeredProviders(settings)).toEqual([])
})
