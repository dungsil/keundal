import { EventType } from '@keundal/core'
import { WORKSPACE_CHANGES_EVENT, type WorkspaceChanges } from '@keundal/workspace-changes/shared'
import { expect, test } from 'vitest'
import { ChatMessageAssembly } from '../shared/utils/chat-message'

const value: WorkspaceChanges = { version: 1, runId: 'run', status: 'partial', files: [
  { path: 'file', kind: 'modified', before: 'old\n', after: 'new\n', additions: 1, deletions: 1 }
] }

test('journal을 다시 재생하면 턴별 최신 Diff 하나를 복원하고 모델 메시지에서 제외한다', () => {
  const assembly = new ChatMessageAssembly('run')
  for (const status of ['partial', 'complete'] as const) {
    assembly.apply({ type: EventType.CUSTOM, name: WORKSPACE_CHANGES_EVENT, value: { ...value, status } })
  }
  assembly.finish('test')
  const restored = JSON.parse(JSON.stringify(assembly.message))
  expect(restored.parts.filter((part: { type: string }) => part.type === 'data-workspace-changes')).toEqual([
    { type: 'data-workspace-changes', data: { ...value, status: 'complete' } }
  ])
  expect(restored.parts.at(-1).data.messages).toEqual([])
})

test('다른 턴의 기록과 잘못된 데이터는 Diff로 표시하지 않는다', () => {
  const assembly = new ChatMessageAssembly('run')
  for (const data of [null, {}, { ...value, runId: 'other' }, { ...value, files: [null] }]) {
    assembly.apply({ type: EventType.CUSTOM, name: WORKSPACE_CHANGES_EVENT, value: data })
  }
  expect(assembly.message.parts).toEqual([])
})

test('대화 전송에는 Diff 원문 대신 참조를 저장하고 다시 열 때 journal에서 복원한다', async () => {
  const { RemoteChatStore } = await import('../shared/utils/remote-chat-store')
  let saved: Record<string, unknown> | undefined
  const data = { ...value, status: 'complete' as const, files: [{ ...value.files[0]!, before: 'x'.repeat(9 * 1024 * 1024) }] }
  const requests: string[] = []
  const store = new RemoteChatStore({ endpoint: 'http://host', token: 'token' }, async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('/runs/run')) return Response.json({ request: { input: { threadId: 'thread' } }, journal: [
      { event: { type: EventType.CUSTOM, name: WORKSPACE_CHANGES_EVENT, value: data } }
    ] })
    if (init?.method === 'PUT') {
      expect(String(init.body).length).toBeLessThan(2000)
      saved = JSON.parse(String(init.body))
      return Response.json({ ...saved, revision: 1 })
    }
    return saved ? Response.json({ ...saved, revision: 1 }) : new Response(null, { status: 404 })
  })
  await store.create('thread', { id: 'run', role: 'assistant', parts: [{ type: 'data-workspace-changes', data }] }, 'openai/gpt-5')
  expect(JSON.stringify(saved)).not.toContain('before')
  expect((await store.get('thread'))?.messages[0]?.parts[0]).toEqual({ type: 'data-workspace-changes', data })
  expect(requests).toContain('http://host/runs/run')
})
