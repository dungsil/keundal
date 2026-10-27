import { setTimeout as delay } from 'node:timers/promises'

import { EventType, LLMService, type LLMEvent, type LLMRequest } from '@keundal/core'
import type { SubtitleSegment, SubtitleTrack } from '@keundal/media'
import { SubtitleTranslationService } from '@keundal/media'
import subtitleTranslatePlugin, {
  LlmSubtitleTranslationService,
  parseTranslatedLines
} from '@keundal/plugin-subtitle-translate'
import { Context } from 'cordis'
import { expect, test, type TestContext } from 'vitest'

class FakeLLM extends LLMService {
  readonly batches: string[][] = []
  active = 0
  peak = 0
  responder: (lines: readonly string[]) => Promise<string> | string = (lines) =>
    JSON.stringify(lines.map((line) => `번역:${line}`))

  constructor(ctx: Context) {
    super(ctx)
  }

  async getModel(): Promise<{ contextWindow: number; maxOutputTokens: number }> {
    return { contextWindow: 200_000, maxOutputTokens: 4_096 }
  }

  async countTokens(): Promise<number> {
    return 0
  }

  stream(request: LLMRequest): AsyncIterable<LLMEvent> {
    const content = request.input.messages.at(-1)?.content
    const payload = JSON.parse(String(content)) as { lines: string[] }
    this.batches.push(payload.lines)
    return this.respond(payload.lines)
  }

  private async *respond(lines: readonly string[]): AsyncIterable<LLMEvent> {
    this.active += 1
    this.peak = Math.max(this.peak, this.active)
    try {
      const text = await this.responder(lines)
      yield { type: EventType.TEXT_MESSAGE_START, messageId: 'm', role: 'assistant' }
      yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: text }
      yield { type: EventType.TEXT_MESSAGE_END, messageId: 'm' }
    } finally {
      this.active -= 1
    }
  }
}

const llmPlugin = Object.assign(
  function fakeLlmPlugin(ctx: Context) {
    new FakeLLM(ctx)
  },
  { inject: [] as string[] }
)

async function setup(t: TestContext, config: Record<string, unknown> = {}) {
  const ctx = new Context()
  await ctx.plugin(llmPlugin)
  const provider = await ctx.plugin(subtitleTranslatePlugin, { retryDelayMs: 1, ...config })
  t.onTestFinished(async () => {
    await provider.dispose()
  })
  return { ctx, llm: ctx.llm as FakeLLM }
}

function track(texts: readonly string[]): SubtitleTrack {
  const segments: SubtitleSegment[] = texts.map((text, index) => ({
    startMs: index * 1_000,
    endMs: index * 1_000 + 900,
    text,
    speaker: index === 0 ? '화자1' : null
  }))
  return { id: 'original', kind: 'original', language: 'en', segments }
}

test('배치로 나눠 번역하고 시각과 화자 정보를 유지한다', async (t) => {
  const { ctx, llm } = await setup(t)
  expect(ctx.subtitleTranslation).toBeInstanceOf(LlmSubtitleTranslationService)
  expect(ctx.subtitleTranslation).toBeInstanceOf(SubtitleTranslationService)
  const result = await ctx.subtitleTranslation.translate({
    track: track(['hello', 'world', 'again']),
    targetLanguage: 'ko',
    model: 'test-model',
    batchSize: 2
  })
  expect(llm.batches.map((batch) => batch.length)).toEqual([2, 1])
  expect(result.requests).toBe(2)
  expect(result.failed).toBe(0)
  expect(result.track.id).toBe('translation:ko')
  expect(result.track.kind).toBe('translation')
  expect(result.track.language).toBe('ko')
  expect(result.track.segments.map((segment) => segment.text)).toEqual(['번역:hello', '번역:world', '번역:again'])
  expect(result.track.segments[0]).toMatchObject({ startMs: 0, endMs: 900, speaker: '화자1' })
})

test('배치 응답이 배열이 아니면 그 배치의 원문을 남긴다', async (t) => {
  const { ctx, llm } = await setup(t, { retries: 0 })
  llm.responder = (lines) =>
    lines.includes('world') ? '미안하지만 번역할 수 없습니다.' : JSON.stringify(lines.map((line) => `번역:${line}`))
  const result = await ctx.subtitleTranslation.translate({
    track: track(['hello', 'world', 'again']),
    targetLanguage: 'ko',
    model: 'test-model',
    batchSize: 2
  })
  expect(result.failed).toBe(2)
  expect(result.track.segments.map((segment) => segment.text)).toEqual(['hello', 'world', '번역:again'])
})

test('속도 제한 오류는 재시도해서 성공한다', async (t) => {
  const { ctx, llm } = await setup(t, { retries: 1 })
  let attempts = 0
  llm.responder = (lines) => {
    attempts += 1
    if (attempts === 1) throw new Error('429 rate limit reached')
    return JSON.stringify(lines.map((line) => `번역:${line}`))
  }
  const result = await ctx.subtitleTranslation.translate({
    track: track(['hello']),
    targetLanguage: 'ko',
    model: 'test-model'
  })
  expect(result.failed).toBe(0)
  expect(result.requests).toBe(2)
  expect(result.track.segments[0]!.text).toBe('번역:hello')
})

test('동시 요청 수 한도를 넘지 않는다', async (t) => {
  const { ctx, llm } = await setup(t, { concurrency: 1, batchSize: 1 })
  llm.responder = async (lines) => {
    await delay(5)
    return JSON.stringify(lines)
  }
  await ctx.subtitleTranslation.translate({
    track: track(['a', 'b', 'c', 'd']),
    targetLanguage: 'ko',
    model: 'test-model'
  })
  expect(llm.peak).toBe(1)
  expect(llm.batches).toHaveLength(4)
})

test('코드 펜스가 붙은 응답도 해석한다', () => {
  expect(parseTranslatedLines('```json\n["가", "나"]\n```', 2)).toEqual(['가', '나'])
  expect(() => parseTranslatedLines('["가"]', 2)).toThrow('instead of 2')
  expect(() => parseTranslatedLines('번역 결과입니다', 1)).toThrow('JSON array')
})

test('빈 구간은 요청에서 빼고 skipped로 센다', async (t) => {
  const { ctx, llm } = await setup(t)
  const result = await ctx.subtitleTranslation.translate({
    track: track(['hello', '   ']),
    targetLanguage: 'ko',
    model: 'test-model'
  })
  expect(result.skipped).toBe(1)
  expect(result.requests).toBe(1)
  expect(llm.batches[0]).toEqual(['hello'])
  expect(result.track.segments).toHaveLength(2)
})

test('대상 언어가 없으면 요청을 거부한다', async (t) => {
  const { ctx } = await setup(t)
  await expect(
    ctx.subtitleTranslation.translate({ track: track(['hello']), targetLanguage: ' ', model: 'test-model' })
  ).rejects.toThrow('targetLanguage')
})
