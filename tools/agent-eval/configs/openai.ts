import { readFile } from 'node:fs/promises'
import process from 'node:process'

import openaiLLMPlugin from '@keundal/plugin-llm-openai'
import { parsePricing } from '@keundal/trace'

import { codingScenarios } from '../src/coding.ts'
import type { EvaluationConfig } from '../src/index.ts'
import { codingCandidate } from './candidate.ts'

// Explicit limits and prices avoid silently relying on stale provider defaults.
const settingsPath = process.env.EVAL_SETTINGS
if (!settingsPath) throw new Error('EVAL_SETTINGS must point to a JSON settings file')
const settings = JSON.parse(await readFile(settingsPath, 'utf8')) as {
  models: Record<string, { contextWindow: number; maxOutputTokens: number }>
  pricing: unknown
  revision: string
  systemPrompt?: string
}
const pricing = parsePricing(settings.pricing)
export default {
  scenarios: codingScenarios,
  candidates: Object.entries(settings.models).map(([model, limits]) =>
    codingCandidate(
      {
        id: model,
        model,
        revision: settings.revision
      },
      { maxOutputTokens: limits.maxOutputTokens, pricing, systemPrompt: settings.systemPrompt },
      async (ctx) => await ctx.plugin(openaiLLMPlugin, { models: settings.models })
    )
  )
} satisfies EvaluationConfig
