import 'fake-indexeddb/auto'
import { expect, test } from 'vitest'
import { createWebPlatform } from '../app/platform'
import { defaultLLMSettings } from '@keundal/llm-settings'

function storage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value) },
    removeItem: (key) => { data.delete(key) },
    clear: () => data.clear()
  }
}

test('웹 조립은 네이티브 IPC 없이 IndexedDB 대화를 저장하고 재연결 후 복원한다', async () => {
  const platform = createWebPlatform(storage())
  await platform.mcp.load()
  await expect(platform.mcp.save([{ serverName: 'local', transport: 'stdio', command: 'node' }], async () => {})).rejects.toThrow('Streamable HTTP')
  const settings = defaultLLMSettings()
  const options = { getSettings: () => settings, getModels: () => [], skills: [] }
  expect(await platform.skills.listFiles()).toEqual({ roots: [], files: [] })
  const first = await platform.connect(options)
  const id = crypto.randomUUID()
  try {
    expect(first.remoteAgent).toBe(false)
    await first.store.create(id, { id: 'user', role: 'user', parts: [{ type: 'text', text: 'Hello' }] }, 'openai/test')
  } finally {
    await first.dispose()
  }
  const second = await platform.connect(options)
  try {
    expect((await second.store.get(id))?.messages[0]?.id).toBe('user')
    await second.store.delete(id)
  } finally {
    await second.dispose()
  }
})
