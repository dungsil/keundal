import { EventType } from '@keundal/core'
import fc from 'fast-check'

import type { ConformanceStore } from './index.js'

interface ConformanceAssertions {
  strictEqual(actual: unknown, expected: unknown): void
  deepStrictEqual(actual: unknown, expected: unknown): void
  match(actual: string, expected: RegExp): void
}

/** 실제 저장소의 공개 커밋 경계에서 도착 순서와 중복 횟수를 바꿉니다. */
export async function checkConcurrentCommitProperties(
  makeStore: () => Promise<ConformanceStore>,
  assert: ConformanceAssertions
): Promise<void> {
  await fc.assert(
    fc.asyncProperty(fc.scheduler(), fc.integer({ min: 2, max: 6 }), async (scheduler, count) => {
      const store = await makeStore()
      try {
        const results = await scheduler.waitFor(
          Promise.all(
            Array.from({ length: count }, (_, index) =>
              scheduler.schedule(Promise.resolve(), `commit-${index}`).then(async () => {
                try {
                  await store.session.commit({
                    threadId: 'race',
                    expectedRevision: 0,
                    messages: [{ id: `m-${index}`, role: 'user', content: `${index}` }]
                  })
                  return index
                } catch (error) {
                  assert.match(String(error), /revision conflict/)
                  return undefined
                }
              })
            )
          )
        )
        const winners = results.filter((value) => value !== undefined)
        assert.strictEqual(winners.length, 1)
        const session = await store.session.get('race')
        assert.strictEqual(session?.revision, 1)
        assert.deepStrictEqual(
          session?.messages.map((message) => message.id),
          [`m-${winners[0]}`]
        )

        const request = {
          input: { threadId: 'terminal', runId: 'run', messages: [], state: undefined, tools: [], context: [] },
          model: 'test',
          maxOutputTokens: 20,
          sessionRevision: 0
        }
        const messages = [{ id: 'reply', role: 'assistant' as const, content: 'once' }]
        const journal = [
          { sequence: 0, event: { type: EventType.RUN_STARTED, threadId: 'terminal', runId: 'run' } },
          {
            sequence: 1,
            event: { type: EventType.RUN_FINISHED, threadId: 'terminal', runId: 'run', outcome: { type: 'success' } }
          }
        ]
        await scheduler.waitFor(
          Promise.all(
            Array.from({ length: count }, (_, index) =>
              scheduler.schedule(Promise.resolve(), `terminal-${index}`).then(() =>
                store.session.commit({
                  threadId: 'terminal',
                  expectedRevision: 0,
                  messages,
                  generation: { request, status: 'completed', journal, messages }
                })
              )
            )
          )
        )
        assert.strictEqual((await store.session.get('terminal'))?.revision, 1)
        assert.deepStrictEqual((await store.session.get('terminal'))?.messages, messages)
        const snapshot = await store.generation.get('run')
        assert.strictEqual(snapshot?.status, 'completed')
        assert.deepStrictEqual(snapshot?.journal, journal)
        const replay = []
        for await (const entry of store.generation.subscribe('run', { afterSequence: 0 })) replay.push(entry)
        assert.deepStrictEqual(replay, journal.slice(1))
      } finally {
        await store.disposeAll()
      }
    }),
    { numRuns: 20 }
  )
}
