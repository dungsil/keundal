import { EventType } from '@keundal/core'
import { LLMService, type LLMEvent, type LLMRequest } from '@keundal/llm'
import { llmUsageEvent } from '@keundal/trace'

import { codingScenarios } from '../src/coding.ts'
import { type EvaluationConfig } from '../src/index.ts'
import { codingCandidate } from './candidate.ts'

// Scripted providers exercise the real coding agent loop, tools, grading and trace accounting.
// They are harness controls, NOT measurements of real model quality or prices.
export default {
  scenarios: codingScenarios,
  candidates: [false, true].map((correct) => {
    const model = correct ? 'scripted-correct' : 'scripted-broken'
    class ScriptedLLM extends LLMService {
      async getModel() {
        return { contextWindow: 32000, maxOutputTokens: 2048 }
      }
      async countTokens() {
        return 100
      }
      async *stream(request: LLMRequest): AsyncGenerator<LLMEvent> {
        yield llmUsageEvent({ source: 'provider', inputTokens: 100, outputTokens: correct ? 50 : 20 })
        if (request.input.messages.some((message) => message.role === 'tool')) return
        const prompt = request.input.messages.find((message) => message.role === 'user')?.content
        const median = typeof prompt === 'string' && prompt.toLowerCase().includes('median')
        const content = !correct
          ? 'export function slug() { return 0 } export function median() { return 0 }\n'
          : median
            ? 'export function median(values) { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); const i = Math.floor(sorted.length/2); if (sorted.length % 2) return sorted[i]; const a = sorted[i-1], b = sorted[i], sum = a+b; return Number.isFinite(sum) ? sum/2 : a/2+b/2 }\n'
            : 'export function slug(value) { return value.replace(/[A-Z]/g, c => c.toLowerCase()).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") }\n'
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'write', toolCallName: 'write_file' }
        yield {
          type: EventType.TOOL_CALL_ARGS,
          toolCallId: 'write',
          delta: JSON.stringify({ path: 'solution.mjs', content })
        }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'write' }
      }
    }
    return codingCandidate(
      { id: model, model, revision: 'demo-v1' },
      {
        maxOutputTokens: 2048,
        pricing: { currency: 'USD', models: { [model]: { inputPerMillion: 1, outputPerMillion: correct ? 4 : 2 } } }
      },
      async (ctx) => await ctx.plugin(ScriptedLLM)
    )
  })
} satisfies EvaluationConfig
