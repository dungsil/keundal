import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LocalFileReferenceService,
  SessionReferenceError,
  SessionReferenceResolver,
  activeAtToken,
  createFileReferenceContext,
  decodeSessionReferenceUri,
  encodeSessionReferenceUri,
  formatFileMention,
  formatSessionReferenceMention,
  parseSessionReferenceText,
  type LocalFileReferenceConfig,
  type SessionReferenceConfig
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
import { Context } from 'cordis'
import { afterEach, describe, expect, test } from 'vitest'

const fixture: RunAgentInput = {
  threadId: 'current',
  runId: 'run',
  state: {},
  context: [],
  messages: [],
  tools: [],
  forwardedProps: {}
}
const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('참조 문법과 로컬 파일 완성', () => {
  test('커서의 @ 토큰과 공백 경로 인용을 해석하고 안전한 멘션을 만든다', () => {
    expect(activeAtToken('check @src/fi', 13)).toEqual({ prefix: '@src/fi', query: 'src/fi', quoted: false })
    expect(activeAtToken('mail me@example.com', 19)).toBeUndefined()
    expect(activeAtToken('open @"some dir/fi', 18)).toEqual({
      prefix: '@"some dir/fi',
      query: 'some dir/fi',
      quoted: true
    })
    expect(formatFileMention({ path: 'some dir', kind: 'directory' }, true)).toBe('@"some dir/')
    expect(formatFileMention({ path: 'a"b', kind: 'file' })).toBeUndefined()
  })

  test('경로만 정렬해 반환하고 숨김·제외 디렉터리·결과 수·취소를 적용한다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keundal-references-'))
    directories.push(root)
    await mkdir(join(root, 'src'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(join(root, 'src', 'some file.ts'), 'secret file contents')
    await writeFile(join(root, 'src', 'sample.ts'), 'another secret')
    await writeFile(join(root, '.hidden'), 'hidden')
    await writeFile(join(root, 'node_modules', 'excluded.js'), 'excluded')
    const ctx = new Context()
    const service = new LocalFileReferenceService(ctx, { root, maxResults: 1 } satisfies LocalFileReferenceConfig)
    const quoted = await service.list('src/s')
    expect(await service.list('src/zzz')).toEqual([])
    expect(quoted).toEqual([{ path: 'src/sample.ts', kind: 'file' }])
    expect(await service.list('secret')).toEqual([])
    expect((await service.list('')).some((candidate) => candidate.path === 'node_modules')).toBe(false)
    const controller = new AbortController()
    controller.abort(new Error('stop'))
    await expect(service.list('src/', controller.signal)).rejects.toThrow()
    await expect(service.list('src/')).resolves.toHaveLength(1)
  })

  test('도구 후속 단계에서 새 파일을 경로 완성에 반영한다', async () => {
    const root = await mkdtemp(join(tmpdir(), 'keundal-reference-refresh-'))
    directories.push(root)
    const service = new LocalFileReferenceService(new Context(), { root })
    expect(await service.list('new')).toEqual([])
    await writeFile(join(root, 'new.ts'), 'created by a tool')
    await createFileReferenceContext(service)(fixture, { step: 2, request: fixture })
    expect(await service.list('new')).toEqual([{ path: 'new.ts', kind: 'file' }])
  })
})

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
