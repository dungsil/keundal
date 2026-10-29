import {
  defaultLLMSettings,
  llmSettingsSchema,
  providerIcon,
  providerType,
  registeredProviders
} from '@keundal/llm-settings'
import { expect, test } from 'vitest'

test('설정하지 않은 기본 공급자는 등록 목록에 표시하지 않는다', () => {
  expect(registeredProviders(defaultLLMSettings())).toEqual([])
  expect(registeredProviders(llmSettingsSchema.parse({ openai: { apiKey: '', baseURL: '', headers: {} } }))).toEqual([])
})

test('기존 키·주소·헤더 설정은 등록 목록에 유지하고 빈 기본 항목은 제외한다', () => {
  const settings = defaultLLMSettings()
  settings.openai.apiKey = 'saved-key'
  expect(registeredProviders(settings).map((item) => item.id)).toEqual(['openai'])
  settings.google.baseURL = 'http://localhost:8080'
  settings.anthropic.headers = { 'x-api-key': 'saved-header' }
  expect(registeredProviders(settings).map((item) => item.id)).toEqual(['anthropic', 'google', 'openai'])
})

test('명시적으로 추가한 공급자는 인증이 없어도 표시하고 삭제하면 빈 목록을 반환한다', () => {
  const settings = defaultLLMSettings()
  settings['openai@local'] = { name: 'Local', apiKey: '', baseURL: '' }
  expect(registeredProviders(settings)).toMatchObject([{ id: 'openai@local', label: 'Local', providerType: 'openai' }])
  delete settings['openai@local']
  expect(registeredProviders(settings)).toEqual([])
})

test('목업 공급자를 인증 정보 없이 저장하고 별도 종류와 아이콘으로 구분한다', () => {
  const settings = defaultLLMSettings()
  settings['mock@demo'] = { name: 'Mock LLM', apiKey: '', baseURL: '' }
  const parsed = llmSettingsSchema.parse(settings)
  expect(registeredProviders(parsed)).toMatchObject([{ id: 'mock@demo', providerType: 'mock', label: 'Mock LLM' }])
  expect(providerType('mock@demo')).toBe('mock')
  expect(providerIcon('mock@demo')).toBe('i-lucide-flask-conical')
})

test('OpenAI Responses API와 Chat Completions API는 서로 다른 공급자 종류로 등록한다', () => {
  const settings = defaultLLMSettings()
  settings.openai.apiKey = 'responses-key'
  settings['openai-chat'].apiKey = 'chat-key'
  expect(registeredProviders(settings)).toMatchObject([
    { id: 'openai', providerType: 'openai' },
    { id: 'openai-chat', providerType: 'openai-chat' }
  ])
  expect(providerType('openai')).toBe('openai')
  expect(providerType('openai-chat')).toBe('openai-chat')
  expect(providerType('openai-chat@work')).toBe('openai-chat')
  expect(() => providerType('openai-chats')).toThrow('Unknown provider configuration')
})

test('같은 회사의 API 종류는 같은 아이콘을 사용한다', () => {
  expect(providerIcon('openai')).toBe('i-simple-icons-openai')
  expect(providerIcon('openai-chat')).toBe('i-simple-icons-openai')
  expect(providerIcon('openai-chat@work')).toBe('i-simple-icons-openai')
  expect(providerIcon('google')).toBe('i-simple-icons-google')
})
