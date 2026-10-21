import { Context } from 'cordis'
import { EventType, LLMService, type LLMRequest, type LLMEvent } from '@keundal/core'
import memoryStorePlugin from '@keundal/plugin-store-memory'
import { createKeundalChat } from '@keundal/plugin-chat-local/keundal'
import agentPlugin from '@keundal/agent'
import { createChatTools } from '@keundal/chat/tools/agent'
import type { invoke } from '@tauri-apps/api/core'
import { expect, test, vi } from 'vitest'
import { McpManager } from '@keundal/plugin-chat-browser/mcp'

function storage() {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) }
  }
}
const remote = { serverName: 'docs', transport: 'streamable-http', url: 'https://example.com/mcp', permissions: { tools: ['search'] } }

test('웹 설정을 저장하고 다시 불러오며 삭제하면 저장소를 비운다', async () => {
  const local = storage()
  const manager = new McpManager(local)
  const restart = vi.fn(async () => {})
  await manager.save([remote], restart)
  const restored = new McpManager(local)
  await restored.load()
  expect(restored.configuration).toEqual([remote])
  expect(restart).toHaveBeenCalledOnce()
  await manager.save([], restart)
  expect(local.values.size).toBe(0)
})

test('웹에서 stdio와 중복 서버를 거부하고 기존 설정을 유지한다', async () => {
  const manager = new McpManager(storage())
  const restart = vi.fn(async () => {})
  await manager.save([remote], restart)
  await expect(manager.save([{ serverName: 'local', transport: 'stdio', command: 'node' }], restart)).rejects.toThrow('Streamable HTTP')
  await expect(manager.save([remote, remote], restart)).rejects.toThrow('Duplicate')
  expect(manager.configuration).toEqual([remote])
  expect(restart).toHaveBeenCalledOnce()
})

test('호스트 재시작에 실패하면 저장된 설정과 적용 중인 설정을 되돌린다', async () => {
  const local = storage()
  const manager = new McpManager(local)
  await manager.save([remote], async () => {})
  await expect(manager.save([], async () => {
    throw new Error('restart failed')
  })).rejects.toThrow('restart failed')
  const restored = new McpManager(local)
  await restored.load()
  expect(manager.configuration).toEqual([remote])
  expect(restored.configuration).toEqual([remote])
})

test('데스크톱의 stdio 인증 정보는 OS 보안 저장소만 사용한다', async () => {
  const local = storage()
  let saved: string | null = null
  const native = vi.fn(async (command: string, args?: { settings: string | null }) => {
    if (command === 'load_mcp_settings') return saved
    if (command === 'save_mcp_settings') saved = args!.settings
    return null
  }) as unknown as typeof invoke
  const manager = new McpManager(local, native)
  const config = { serverName: 'local', transport: 'stdio', command: 'node', env: { TOKEN: 'test-value' } }
  await manager.save([config], async () => {})
  const restored = new McpManager(local, native)
  await restored.load()
  expect(restored.configuration).toEqual([config])
  expect(local.values.size).toBe(0)
})

test('보안 저장소에 접근하지 못하면 브라우저 저장소로 대체하지 않는다', async () => {
  const local = storage()
  const native = vi.fn(async () => {
    throw new Error('locked')
  }) as unknown as typeof invoke
  const manager = new McpManager(local, native)
  await expect(manager.load()).rejects.toThrow('locked')
  await expect(manager.save([remote], async () => {})).rejects.toThrow('locked')
  expect(local.values.size).toBe(0)
})

test('웹 대화의 에이전트는 MCP 도구를 실행하고 결과를 모델에 전달한다', async (t) => {
  const ctx = new Context()
  const requests: LLMRequest[] = []
  class LLM extends LLMService {
    async getModel() { return { contextWindow: 128000, maxOutputTokens: 4096 } }
    async countTokens() { return 40 }
    async* stream(request: LLMRequest): AsyncIterable<LLMEvent> {
      requests.push(structuredClone(request))
      if (requests.length === 1) {
        yield { type: EventType.TOOL_CALL_START, toolCallId: 'load', toolCallName: 'mcp__docs__tool__search' }
        yield { type: EventType.TOOL_CALL_ARGS, toolCallId: 'load', delta: '{}' }
        yield { type: EventType.TOOL_CALL_END, toolCallId: 'load' }
      } else {
        yield { type: EventType.TEXT_MESSAGE_START, messageId: 'answer', role: 'assistant' }
        yield { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'answer', delta: 'Reviewed' }
        yield { type: EventType.TEXT_MESSAGE_END, messageId: 'answer' }
      }
    }
  }
  const llm = await ctx.plugin(LLM)
  const store = await ctx.plugin(memoryStorePlugin)
  t.onTestFinished(async () => {
    await store.dispose()
    await llm.dispose()
  })
  const tools = vi.fn(async () => [{ name: 'mcp__docs__tool__search', description: 'Search', parameters: { type: 'object' }, execute: async () => JSON.stringify({ content: [{ type: 'text', text: 'MCP search result' }] }) }])
  const runtime = await createKeundalChat(ctx, 'openai/gpt-5-nano', {}, async (ctx, config) => ctx.plugin(agentPlugin, { ...config, tools: async () => [...createChatTools(), ...await tools()] }))
  t.onTestFinished(() => runtime.dispose())
  const events = []
  for await (const event of runtime.respond({ threadId: 'chat', instructions: 'Be helpful.', messages: [{ id: 'question', role: 'user', parts: [{ type: 'text', text: 'Review my code.' }] }] })) events.push(event)
  expect(events.at(-1), JSON.stringify(events)).toMatchObject({ type: EventType.RUN_FINISHED })
  expect(tools).toHaveBeenCalledOnce()
  expect(JSON.stringify(requests[0])).toContain('mcp__docs__tool__search')
  expect(JSON.stringify(requests[0])).toContain('weather')
  expect(requests[1]!.input.messages).toContainEqual(expect.objectContaining({ role: 'tool', content: JSON.stringify({ content: [{ type: 'text', text: 'MCP search result' }] }) }))
})

test('데스크톱 서버별 HTTP 허용을 저장하고 다시 불러와도 다른 서버에는 적용하지 않는다', async () => {
  const local = storage()
  let saved: string | null = null
  const native = vi.fn(async (command: string, args?: { settings: string | null }) => {
    if (command === 'load_mcp_settings') return saved
    if (command === 'save_mcp_settings') saved = args!.settings
    return null
  }) as unknown as typeof invoke
  const manager = new McpManager(local, native)
  const config = { ...remote, url: 'http://192.168.1.20/mcp', allowInsecureHttp: true }
  await manager.save([config], async () => {})
  const restored = new McpManager(local, native)
  await restored.load()
  expect(restored.configuration).toEqual([config])
  await expect(restored.save([config, { ...remote, serverName: 'other', url: config.url }], async () => {})).rejects.toThrow('HTTPS')
  expect(restored.configuration).toEqual([config])
  expect(local.values.size).toBe(0)
})
