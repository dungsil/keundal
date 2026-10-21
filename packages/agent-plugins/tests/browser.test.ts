import { inspectAgentPlugin, PLUGIN_SCHEMA, MCP_SCHEMA } from '@keundal/agent-plugins/browser'
import { expect, test } from 'vitest'

test('브라우저는 플러그인 스킬과 HTTP 서버를 읽고 지원하지 않는 구성요소만 진단한다', async () => {
  const plugin = await inspectAgentPlugin({
    'plugin.json': JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'reports', version: '1.2.0' }),
    'skills/review/SKILL.md': '---\nname: review\ndescription: Review reports\n---\nRead the report.',
    'skills/broken/SKILL.md': 'invalid',
    'mcp.json': JSON.stringify({
      $schema: MCP_SCHEMA,
      mcpServers: {
        reports: { type: 'streamable-http', url: 'https://example.com/mcp' },
        local: { type: 'stdio', command: 'node' },
        unsafe: { type: 'streamable-http', url: 'http://example.com/mcp' }
      }
    })
  })
  expect(plugin.manifest.name).toBe('reports')
  expect(plugin.skills).toEqual([
    {
      name: 'review',
      description: 'Review reports',
      content: '---\nname: review\ndescription: Review reports\n---\nRead the report.'
    }
  ])
  expect(plugin.servers).toEqual([
    { serverName: 'reports', transport: 'streamable-http', url: 'https://example.com/mcp', redirect: 'error' }
  ])
  expect(plugin.diagnostics.map((d) => d.entry).sort()).toEqual(['broken', 'local', 'unsafe'])
})

test('브라우저도 잘못된 매니페스트와 루트 밖 경로를 거부한다', async () => {
  await expect(inspectAgentPlugin({ 'plugin.json': '{"name":"reports"}' })).rejects.toThrow('schema')
  await expect(inspectAgentPlugin({ '../plugin.json': '{}' })).rejects.toThrow('path')
})
