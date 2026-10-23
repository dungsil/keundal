import { resolveModel } from '@keundal/chat/models'
import type { ReasoningLevel } from '@keundal/core'

export function reasoningLevels(model: string): ReasoningLevel[] {
  const { provider, id } = resolveModel(model)
  if ((provider === 'openai' || provider === 'openai-chat') && !/^(gpt-5|o\d)(?:[-.]|$)/.test(id)) return []
  if (provider === 'google' && id.startsWith('gemini-3') && !id.includes('flash')) return ['low', 'high']
  return ['low', 'medium', 'high']
}

export function selectedReasoning(value: unknown, levels: readonly ReasoningLevel[]): ReasoningLevel {
  const preferred = value === false ? 'low' : value
  if (levels.includes(preferred as ReasoningLevel)) return preferred as ReasoningLevel
  return levels.includes('medium') ? 'medium' : (levels.at(-1) ?? 'medium')
}
