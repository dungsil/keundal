import { expect, test, vi } from 'vitest'
import { createDesktopPlatform } from '../app/platform'
import { defaultLLMSettings } from '@keundal/chat/llm-settings'
import type { NativeInvoke } from '@keundal/chat/platform'

test('데스크톱 조립은 보안 저장소와 로컬 스킬을 제공하고 sidecar에 연결한다', async () => {
  const commands: string[] = []
  const requests: string[] = []
  const storage: Storage = { length: 0, key: () => null, getItem: () => null, setItem: () => {
    throw new Error('No plaintext settings')
  }, removeItem: () => {}, clear: () => {} }
  const invoke: NativeInvoke = async <T>(command: string) => {
    commands.push(command)
    if (command === 'load_mcp_settings') return null as T
    if (command === 'save_mcp_settings') return undefined as T
    if (command === 'load_llm_settings') return null as T
    if (command === 'save_llm_settings') return undefined as T
    if (command === 'list_skill_files') return { roots: [], files: [] } as T
    if (command === 'sidecar_info') return { endpoint: 'http://sidecar.test', token: 'test-token' } as T
    throw new Error(command)
  }
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer test-token')
    requests.push(url)
    return Response.json([])
  })
  try {
    const platform = createDesktopPlatform(storage, invoke)
    await platform.mcp.load()
    await platform.mcp.save([{ serverName: 'local', transport: 'stdio', command: 'node' }], async () => {})
    expect(platform.mcp.configuration[0]?.transport).toBe('stdio')
    expect(commands).toContain('save_mcp_settings')
    const settings = await platform.settings.load()
    expect(settings).toEqual(defaultLLMSettings())
    await platform.settings.save(settings)
    expect(await platform.skillFiles?.list()).toEqual({ roots: [], files: [] })
    const connection = await platform.connect({ getSettings: () => settings, getModels: () => [], initialModel: 'openai/test', skills: [] })
    try {
      expect(connection.remoteAgent).toBe(true)
      expect(connection.selectedModel).toBe('openai/test')
      await connection.selectModel?.('anthropic/test')
      expect(commands.filter(command => command === 'sidecar_info')).toHaveLength(2)
      expect(requests).toEqual(['http://sidecar.test/recover'])
    } finally {
      await connection.dispose()
    }
  } finally {
    vi.unstubAllGlobals()
  }
})
