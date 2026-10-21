import type { Reasoning, ReasoningLevel } from '@keundal/core'
import { reasoningLevels, selectedReasoning } from '../../shared/utils/reasoning-settings'
import { FALLBACK_MODEL } from '@keundal/llm-settings'

export function useChatSettings() {
  const webSearch = useCookie<boolean>('web-search', { default: () => true })
  const preference = useCookie<Reasoning>('reasoning', { default: () => 'medium' })
  const model = useState('chat-model', () => FALLBACK_MODEL)
  const levels = computed(() => reasoningLevels(model.value))
  const reasoning = computed<ReasoningLevel>({
    get: () => selectedReasoning(preference.value, levels.value),
    set: (value) => { preference.value = value }
  })

  return { webSearch, reasoning, reasoningLevels: levels }
}
