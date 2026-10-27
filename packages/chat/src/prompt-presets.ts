import { assemblePrompt, parsePromptPreset, type PromptPreset } from '@keundal/prompt'

export { assemblePrompt, parsePromptPreset, type PromptPreset, type PromptBlock } from '@keundal/prompt'

export interface PromptPresetSettings {
  activePresetId: string | null
  presets: PromptPreset[]
}

export const PROMPT_PRESETS_KEY = 'keundal:prompt-presets'

export function parsePromptPresetSettings(value: unknown): PromptPresetSettings {
  if (
    !value ||
    typeof value !== 'object' ||
    !('presets' in value) ||
    !Array.isArray(value.presets) ||
    value.presets.length > 32 ||
    !('activePresetId' in value) ||
    (value.activePresetId !== null && typeof value.activePresetId !== 'string')
  ) {
    throw new Error('Invalid prompt preset settings')
  }
  const presets = value.presets.map(parsePromptPreset)
  if (
    new Set(presets.map((preset) => preset.id)).size !== presets.length ||
    (value.activePresetId !== null && !presets.some((preset) => preset.id === value.activePresetId))
  ) {
    throw new Error('Invalid prompt preset selection')
  }
  for (const preset of presets) assemblePrompt([], preset)
  return { activePresetId: value.activePresetId, presets }
}

/** Read the old single instruction without deleting it until a new configuration is saved. */
export function loadPromptPresets(storage: Pick<Storage, 'getItem'>): PromptPresetSettings {
  const saved = storage.getItem(PROMPT_PRESETS_KEY)
  if (saved !== null) return parsePromptPresetSettings(JSON.parse(saved))
  const legacy = storage.getItem('keundal:system-prompt')?.trim()
  return legacy
    ? {
        activePresetId: 'default',
        presets: [
          {
            id: 'default',
            name: 'Default',
            variables: {},
            blocks: [
              {
                id: 'instructions',
                type: 'text',
                name: 'Instructions',
                enabled: true,
                role: 'system',
                content: legacy
              },
              { id: 'history', type: 'history', name: 'History', enabled: true }
            ]
          }
        ]
      }
    : { activePresetId: null, presets: [] }
}
