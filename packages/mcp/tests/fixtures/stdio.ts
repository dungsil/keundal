import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { createFixture } from './server.ts'

const fixture = createFixture()
if (process.env.MCP_FIXTURE_LARGE_CATALOG === '1') {
  fixture.state.catalog = [[{ name: 'large', description: 'x'.repeat(17 * 1024), inputSchema: { type: 'object' } }]]
}
await fixture.server.connect(new StdioServerTransport())
