import { parseModelRecoveryPolicy, type ModelRecoveryPolicy } from '@keundal/agent'

import { resolveModel } from './models'

export { parseModelRecoveryPolicy, type ModelRecoveryPolicy } from '@keundal/agent'
export const MODEL_RECOVERY_KEY = 'keundal:model-recovery'

export function loadModelRecovery(storage: Pick<Storage, 'getItem'>): ModelRecoveryPolicy | undefined {
  try {
    const saved = storage.getItem(MODEL_RECOVERY_KEY)
    return saved ? parseModelRecoveryPolicy(JSON.parse(saved)) : undefined
  } catch {
    return undefined
  }
}

export function saveModelRecovery(storage: Pick<Storage, 'setItem'>, value: ModelRecoveryPolicy) {
  const policy = parseModelRecoveryPolicy(value)
  const fallbackModels = policy.fallbackModels?.map((model) => resolveModel(model).value)
  const normalized = parseModelRecoveryPolicy({ ...policy, fallbackModels })
  storage.setItem(MODEL_RECOVERY_KEY, JSON.stringify(normalized))
  return normalized
}

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
