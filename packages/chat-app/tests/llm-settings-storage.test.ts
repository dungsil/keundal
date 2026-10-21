import type { invoke } from '@tauri-apps/api/core'
import { expect, test } from 'vitest'
import { defaultLLMSettings } from '@keundal/llm-settings'
import { LLM_SETTINGS_KEY } from '@keundal/chat/platform'
import { createBrowserSettingsStorage } from '@keundal/plugin-chat-browser'
import { createNativeSettingsStorage } from '@keundal/plugin-chat-desktop/settings'

function fixture() {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
  const native = { secret: null as string | null, available: true }
  const invokeNative: typeof invoke = async <T>(command: string, args?: Parameters<typeof invoke>[1]) => {
    if (!native.available) throw new Error('Secret store locked')
    if (command === 'load_llm_settings') return native.secret as T
    if (command !== 'save_llm_settings') throw new Error('Unknown command')
    native.secret = (args as { settings: string | null }).settings
    return undefined as T
  }
  const settings = defaultLLMSettings()
  settings.anthropic = { apiKey: 'anthropic-private', baseURL: 'https://anthropic.example', headers: { 'x-private': 'header-private' } }
  settings.openai = { apiKey: 'openai-private', baseURL: '' }
  return { values, storage, native, invokeNative, settings }
}

test('웹은 기존 localStorage에 공급자 설정을 저장하고 다시 불러온다', async () => {
  const { storage, values, settings } = fixture()
  await createBrowserSettingsStorage(storage).save(settings)
  expect(JSON.parse(values.get(LLM_SETTINGS_KEY)!)).toEqual(settings)
  expect(await createBrowserSettingsStorage(storage).load()).toEqual(settings)
})

test('데스크톱은 키·URL·헤더를 네이티브 저장소에만 저장하고 다시 불러오며 공급자별로 삭제한다', async () => {
  const { storage, values, native, invokeNative, settings } = fixture()
  const persistence = createNativeSettingsStorage(storage, invokeNative)
  await persistence.save(settings)
  expect(values.size).toBe(0)
  expect(JSON.parse(native.secret!)).toEqual(settings)
  expect(await createNativeSettingsStorage(storage, invokeNative).load()).toEqual(settings)
  settings.anthropic = { apiKey: '', baseURL: '' }
  await persistence.save(settings)
  const restored = await persistence.load()
  expect(restored.anthropic).toEqual({ apiKey: '', baseURL: '' })
  expect(restored.openai).toEqual({ apiKey: 'openai-private', baseURL: '' })
  await persistence.save(defaultLLMSettings())
  expect(native.secret).toBeNull()
  expect(await persistence.load()).toEqual(defaultLLMSettings())
  expect(values.size).toBe(0)
})

test('데스크톱은 기존 평문 설정을 안전하게 이전하고 이후에는 보안 저장소를 우선한다', async () => {
  const { storage, values, native, invokeNative, settings } = fixture()
  storage.setItem(LLM_SETTINGS_KEY, JSON.stringify({ openai: settings.openai }))
  const persistence = createNativeSettingsStorage(storage, invokeNative)
  expect(await persistence.load()).toEqual({ ...defaultLLMSettings(), openai: settings.openai })
  expect(JSON.parse(native.secret!)).toEqual({ ...defaultLLMSettings(), openai: settings.openai })
  expect(values.has(LLM_SETTINGS_KEY)).toBe(false)
  storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings))
  expect((await persistence.load()).anthropic.apiKey).toBe('')
  expect(values.has(LLM_SETTINGS_KEY)).toBe(false)
})

test('보안 저장소 조회·저장 실패 시 평문으로 대체하거나 기존 설정을 지우지 않는다', async () => {
  const { storage, values, native, invokeNative, settings } = fixture()
  storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(settings))
  native.available = false
  const persistence = createNativeSettingsStorage(storage, invokeNative)
  await expect(persistence.load()).rejects.toThrow()
  await expect(persistence.save(defaultLLMSettings())).rejects.toThrow()
  expect(JSON.parse(values.get(LLM_SETTINGS_KEY)!)).toEqual(settings)
  native.available = true
  const failSave: typeof invoke = (command, args) => command === 'save_llm_settings' ? Promise.reject(new Error('Write denied')) : invokeNative(command, args)
  await expect(createNativeSettingsStorage(storage, failSave).load()).rejects.toThrow()
  expect(native.secret).toBeNull()
  expect(JSON.parse(values.get(LLM_SETTINGS_KEY)!)).toEqual(settings)
})

test('잘못된 설정은 저장·이전하지 않고 기존 보안 설정을 유지한다', async () => {
  const { storage, native, invokeNative, settings } = fixture()
  const persistence = createNativeSettingsStorage(storage, invokeNative)
  await persistence.save(settings)
  const invalid = { ...settings, openai: { apiKey: 'private', baseURL: 'http://untrusted.example' } }
  await expect(persistence.save(invalid)).rejects.toThrow()
  expect(await persistence.load()).toEqual(settings)
  native.secret = null
  storage.setItem(LLM_SETTINGS_KEY, JSON.stringify(invalid))
  await expect(persistence.load()).rejects.toThrow()
  expect(native.secret).toBeNull()
  expect(storage.getItem(LLM_SETTINGS_KEY)).toBe(JSON.stringify(invalid))
})

test('추가 공급자를 웹과 보안 저장소에 보존하고 하나를 삭제해도 나머지 설정을 유지한다', async () => {
  for (const desktop of [false, true]) {
    const { storage, invokeNative, settings } = fixture()
    const persistence = desktop ? createNativeSettingsStorage(storage, invokeNative) : createBrowserSettingsStorage(storage)
    settings['openai@work'] = { name: 'Work', apiKey: 'work-key', baseURL: 'https://work.example/v1' }
    settings['openai@home'] = { name: 'Home', apiKey: 'home-key', baseURL: 'https://home.example/v1' }
    await persistence.save(settings)
    expect(await persistence.load()).toEqual(settings)
    delete settings['openai@work']
    await persistence.save(settings)
    expect(await persistence.load()).toEqual(settings)
  }
})
