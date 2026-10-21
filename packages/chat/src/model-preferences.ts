import { resolveModel } from './models'

export const MODEL_KEY = 'keundal:model'
export const TITLE_MODEL_KEY = 'keundal:title-model'
export const DEFAULT_MODEL_KEY = 'keundal:default-model'

export function readModelPreference(storage: Pick<Storage, 'getItem'>, key: string) {
  try {
    const value = storage.getItem(key)
    return value ? resolveModel(value).value : undefined
  } catch {
    // Invalid preferences or unavailable storage must not prevent startup.
    return undefined
  }
}

export function loadModelPreferences(storage: Pick<Storage, 'getItem'>) {
  const defaultModel = readModelPreference(storage, DEFAULT_MODEL_KEY) ?? ''
  return { defaultModel, model: defaultModel || readModelPreference(storage, MODEL_KEY) }
}

export function saveDefaultModel(storage: Pick<Storage, 'setItem' | 'removeItem'>, value: string) {
  if (!value) {
    storage.removeItem(DEFAULT_MODEL_KEY)
    return ''
  }
  const model = resolveModel(value).value
  storage.setItem(DEFAULT_MODEL_KEY, model)
  return model
}

export function saveTitleModel(storage: Pick<Storage, 'setItem' | 'removeItem'>, value: string) {
  if (!value) {
    storage.removeItem(TITLE_MODEL_KEY)
    return ''
  }
  const model = resolveModel(value).value
  storage.setItem(TITLE_MODEL_KEY, model)
  return model
}
