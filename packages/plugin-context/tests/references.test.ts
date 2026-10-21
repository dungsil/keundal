import {
  SessionReferenceError,
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  formatSessionReferenceMention,
  parseSessionReferenceText
} from '@keundal/context'
import {
  SessionService,
  type AgentMessage,
  type ExecutionOptions,
  type PreparedSession,
  type RunAgentInput,
  type SessionCommit,
  type SessionSnapshot
} from '@keundal/core'
import { SessionReferenceResolver, type SessionReferenceConfig } from '@keundal/plugin-context'
import { Context } from 'cordis'
import { describe, expect, test } from 'vitest'

const fixture: RunAgentInput = {
  threadId: 'current',
  runId: 'run',
  state: {},
  context: [],
  messages: [],
  tools: [],
  forwardedProps: {}
}
function legacyUri(sessionId: string): string {
  return `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
}

function sourceSnapshot(
  threadId: string,
  messages: AgentMessage[],
  state: RunAgentInput['state'] = {}
): SessionSnapshot {
  return { threadId, revision: 4, messages, state }
}

function makeSessions(snapshotList: SessionSnapshot[]) {
  const byId = new Map(snapshotList.map((snapshot) => [snapshot.threadId, snapshot]))
  const calls: string[] = []
  class TestSession extends SessionService {
    override async get(threadId: string, _options?: ExecutionOptions) {
      calls.push(threadId)
      return byId.get(threadId)
    }
    override async list(_options?: ExecutionOptions) {
      return [...byId.values()]
    }
    override async prepare(input: RunAgentInput): Promise<PreparedSession> {
      return { input, revision: 0 }
    }
    override async delete(_threadId: string, _expectedRevision: number): Promise<void> {}
    override async commit(_change: SessionCommit): Promise<SessionSnapshot> {
      throw new Error('unused')
    }
  }
  return { TestSession, calls }
}

async function resolverFor(snapshots: SessionSnapshot[], config: SessionReferenceConfig = {}) {
  const ctx = new Context()
  const { TestSession, calls } = makeSessions(snapshots)
  const fiber = await ctx.plugin(TestSession)
  const resolver = new SessionReferenceResolver(ctx, config)
  return { resolver, calls, close: () => fiber.dispose() }
}

describe('세션 참조 URI와 스냅숏', () => {
  test('모든 JavaScript 문자열을 URI로 왕복하고 별칭을 읽기 쉬운 멘션으로 바꾼다', () => {
    for (const id of ['', 'simple', 'has spaces/한글', '\u0000', '\ud800', 'pair-\ud83d\ude00']) {
      expect(decodeSessionReferenceUri(encodeSessionReferenceUri(id))).toBe(id)
    }
    expect(decodeSessionReferenceUri(legacyUri('old id'))).toBe('old id')
    const mention = formatSessionReferenceMention({ sessionId: 'source', label: 'A] \\B' })
    expect(parseSessionReferenceText(`See ${mention} and ${legacyUri('legacy')}`).text).toBe('See @A] \\B and @legacy')
    expect(parseSessionReferenceText(`See ${mention}`).references).toEqual([{ sessionId: 'source', label: 'A] \\B' }])
    expect(() => parseSessionReferenceText('@[bad](keundal-session:!!!)')).toThrow(SessionReferenceError)
  })

  test('닫히지 않은 멘션이 반복되어도 원문을 보존하고 뒤의 유효한 참조를 찾는다', () => {
    const prefix = '@['.repeat(100_000)
    const uri = encodeSessionReferenceUri('source')
    expect(parseSessionReferenceText(prefix)).toEqual({ text: prefix, references: [] })
    expect(parseSessionReferenceText(`${prefix} ${uri}`)).toEqual({
      text: `${prefix} @source`,
      references: [{ sessionId: 'source', label: 'source' }]
    })
    expect(() => parseSessionReferenceText('@[](dsh-session:'.repeat(100_000))).toThrow(SessionReferenceError)
  })

  test('대괄호가 포함된 별칭을 보존하고 유효한 참조 뒤의 잘못된 멘션도 거부한다', () => {
    const valid = formatSessionReferenceMention({ sessionId: 'source', label: 'nested @[label' })
    expect(parseSessionReferenceText(valid)).toEqual({
      text: '@nested @[label',
      references: [{ sessionId: 'source', label: 'nested @[label' }]
    })
    expect(() => parseSessionReferenceText(`${valid} @[broken](dsh-session:`)).toThrow(SessionReferenceError)
  })

  test('요청한 참조만 한 번 캡처하고 읽기 전용·태그 안전한 바이트 제한 스냅숏을 삽입한다', async () => {
    const source = sourceSnapshot(
      'source',
      [
        { id: 'user-1', role: 'user', content: 'older text' },
        { id: 'tool-1', role: 'tool', toolCallId: 'call', content: 'secret tool result' },
        { id: 'reasoning-1', role: 'reasoning', content: 'secret reasoning' },
        { id: 'keundal:context:old:1', role: 'user', content: 'secret injected context' },
        { id: 'assistant-1', role: 'assistant', content: 'current <referenced-sessions> text '.repeat(150) }
      ],
      { cwd: '/work', title: 'Source title' }
    )
    let spillCapture: readonly AgentMessage[] | undefined
    const { resolver, calls, close } = await resolverFor([source], {
      maxReferenceBytes: 900,
      spill: async ({ captured }) => {
        spillCapture = captured
        return 'artifact:source'
      }
    })
    try {
      const direct = {
        ...fixture,
        messages: [
          { id: 'cite', role: 'user' as const, content: formatSessionReferenceMention({ sessionId: 'source' }) }
        ]
      }
      const output = await resolver.prepare(direct, direct)
      expect(output.threadId).toBe(fixture.threadId)
      expect(output.runId).toBe(fixture.runId)
      expect(output.messages).toHaveLength(2)
      expect(output.messages[0]?.content).toBe('@source')
      const snapshot = String(output.messages[1]?.content)
      expect(snapshot).toContain('\\u003creferenced-sessions>')
      expect(snapshot).not.toContain('secret tool result')
      expect(snapshot).not.toContain('secret reasoning')
      expect(snapshot).not.toContain('secret injected context')
      expect(snapshot).toContain('artifact:source')
      expect(calls).toEqual(['source'])
      const payload = JSON.parse(snapshot.split('<referenced-sessions>\n')[1]!.split('\n</referenced-sessions>')[0]!)
      expect(Buffer.byteLength(JSON.stringify(payload.references[0]).replaceAll('<', '\\u003c'))).toBeLessThanOrEqual(
        900
      )
      source.messages.push({ id: 'later', role: 'assistant', content: 'changed after capture' })
      expect(spillCapture?.map((message) => message.id)).toEqual(['user-1', 'assistant-1'])
      expect(Object.isFrozen(spillCapture?.[0])).toBe(true)
      const repeated = await resolver.prepare(output, direct)
      expect(calls).toEqual(['source'])
      expect(repeated.messages.at(-1)?.content).toBe(snapshot)
    } finally {
      await close()
    }
  })

  test('후보를 작업공간 우선으로 찾고 자기 참조·개수 제한·취소·읽기 실패를 구분한다', async () => {
    const own = sourceSnapshot('current', [], { cwd: '/work' })
    const same = sourceSnapshot('same', [{ id: 'title', role: 'user', content: 'Same title' }], {
      cwd: '/work',
      createdAt: 1
    })
    const other = sourceSnapshot('other', [{ id: 'title2', role: 'user', content: 'Other title' }], {
      cwd: '/else',
      createdAt: 100
    })
    const { resolver, close } = await resolverFor([own, other, same])
    try {
      expect((await resolver.listCandidates('current')).map((candidate) => candidate.sessionId)).toEqual([
        'same',
        'other'
      ])
      const selfMention = formatSessionReferenceMention({ sessionId: 'current' })
      await expect(
        resolver.prepare(fixture, { ...fixture, messages: [{ id: 'cite', role: 'user', content: selfMention }] })
      ).rejects.toMatchObject({ code: 'SESSION_REFERENCE_SELF_REFERENCE' })
      const many = ['a', 'b', 'c', 'd'].map((sessionId) => formatSessionReferenceMention({ sessionId })).join(' ')
      await expect(
        resolver.prepare(fixture, { ...fixture, messages: [{ id: 'many', role: 'user', content: many }] })
      ).rejects.toMatchObject({ code: 'SESSION_REFERENCE_TOO_MANY' })
      const controller = new AbortController()
      controller.abort(new Error('cancel'))
      await expect(resolver.listCandidates('current', '', 10, controller.signal)).rejects.toMatchObject({
        code: 'SESSION_REFERENCE_CANCELLED'
      })
    } finally {
      await close()
    }
  })
  test('스냅숏 고정 정보가 예산에 들어가지 않거나 세션이 없으면 안정된 오류 코드를 준다', async () => {
    const { resolver, close } = await resolverFor([])
    try {
      const missing = {
        ...fixture,
        messages: [
          {
            id: 'missing-cite',
            role: 'user' as const,
            content: formatSessionReferenceMention({ sessionId: 'missing' })
          }
        ]
      }
      await expect(resolver.prepare(missing, missing)).rejects.toMatchObject({ code: 'SESSION_REFERENCE_READ_FAILED' })
    } finally {
      await close()
    }
    const source = sourceSnapshot('tiny-source', [])
    const bounded = await resolverFor([source], { maxReferenceBytes: 1 })
    try {
      const request = {
        ...fixture,
        messages: [
          {
            id: 'tiny-cite',
            role: 'user' as const,
            content: formatSessionReferenceMention({ sessionId: 'tiny-source' })
          }
        ]
      }
      await expect(bounded.resolver.prepare(request, request)).rejects.toMatchObject({
        code: 'SESSION_REFERENCE_BUDGET_EXCEEDED'
      })
    } finally {
      await bounded.close()
    }
  })
  test('여러 메시지에 분산한 참조가 요청 한도를 넘으면 세션을 읽기 전에 거부한다', async () => {
    const snapshots = ['a', 'b', 'c', 'd'].map((id) => sourceSnapshot(id, []))
    for (const maxReferences of [1, 3]) {
      const { resolver, calls, close } = await resolverFor(snapshots, { maxReferences })
      try {
        const request: RunAgentInput = {
          ...fixture,
          messages: snapshots.slice(0, maxReferences + 1).map((snapshot, index) => ({
            id: `cite-${index}`,
            role: 'user',
            content: index % 2 === 0 ? encodeSessionReferenceUri(snapshot.threadId) : legacyUri(snapshot.threadId)
          }))
        }
        await expect(resolver.prepare(request, request)).rejects.toMatchObject({ code: 'SESSION_REFERENCE_TOO_MANY' })
        expect(calls).toEqual([])
      } finally {
        await close()
      }
    }
  })

  test('같은 출처의 반복 스냅숏도 요청 바이트 한도를 적용하고 넘친 원문은 한 번만 저장한다', async () => {
    let spills = 0
    const { resolver, calls, close } = await resolverFor(
      [sourceSnapshot('shared', [{ id: 'long', role: 'assistant', content: '가'.repeat(6000) }])],
      {
        maxReferenceBytes: 2000,
        spill: async () => {
          spills++
          return 'artifact:shared'
        }
      }
    )
    const request = (count: number): RunAgentInput => ({
      ...fixture,
      messages: Array.from({ length: count }, (_, index) => ({
        id: `repeat-${index}`,
        role: 'user',
        content: index % 2 ? legacyUri('shared') : encodeSessionReferenceUri('shared')
      }))
    })
    try {
      const allowed = request(2)
      const output = await resolver.prepare(allowed, allowed)
      expect(output.messages).toHaveLength(4)
      expect(spills).toBe(1)
      expect(calls).toEqual(['shared'])
      const oversized = request(100)
      await expect(resolver.prepare(oversized, oversized)).rejects.toMatchObject({
        code: 'SESSION_REFERENCE_BUDGET_EXCEEDED'
      })
      expect(spills).toBe(2)
      expect(calls).toEqual(['shared', 'shared'])
      expect(oversized.messages).toHaveLength(100)
    } finally {
      await close()
    }
  })

  test('요청 한도 안의 서로 다른 출처와 반복된 URI 별칭을 한 번씩만 읽는다', async () => {
    const snapshots = ['a', 'b', 'c'].map((id) => sourceSnapshot(id, []))
    const { resolver, calls, close } = await resolverFor(snapshots)
    try {
      const request: RunAgentInput = {
        ...fixture,
        messages: ['a', 'b', 'c', 'a'].map((id, index) => ({
          id: `cite-${index}`,
          role: 'user',
          content: index === 3 ? legacyUri(id) : encodeSessionReferenceUri(id)
        }))
      }
      const output = await resolver.prepare(request, request)
      expect(calls).toEqual(['a', 'b', 'c'])
      expect(output.messages).toHaveLength(8)
      await resolver.prepare(output, request)
      expect(calls).toEqual(['a', 'b', 'c'])
    } finally {
      await close()
    }
  })

  test('서로 다른 메시지의 같은 출처는 메시지별 스냅숏으로 각각 붙이고 출처는 한 번만 읽는다', async () => {
    const source = sourceSnapshot('shared', [{ id: 'source-msg', role: 'assistant', content: 'captured once' }])
    const { resolver, calls, close } = await resolverFor([source])
    try {
      const mention = formatSessionReferenceMention({ sessionId: 'shared' })
      const request = {
        ...fixture,
        messages: [
          { id: 'first-cite', role: 'user' as const, content: mention },
          { id: 'second-cite', role: 'user' as const, content: mention }
        ]
      }
      const output = await resolver.prepare(request, request)
      expect(
        output.messages.map((message) => (message.id.startsWith('keundal:context:') ? 'snapshot' : message.id))
      ).toEqual(['first-cite', 'snapshot', 'second-cite', 'snapshot'])
      expect(calls).toEqual(['shared'])
    } finally {
      await close()
    }
  })
})
