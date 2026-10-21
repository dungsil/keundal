import { Server } from '@modelcontextprotocol/server'
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

const server = new Server({ name: 'fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler('tools/list', () => ({ tools: [{ name: 'inspect', inputSchema: { type: 'object' } }] }))
server.setRequestHandler('tools/call', () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({
        root: process.env.PLUGIN_ROOT,
        data: process.env.PLUGIN_DATA,
        value: process.env.VALUE,
        cwd: process.cwd(),
        args: process.argv.slice(2),
        pid: process.pid
      })
    }
  ]
}))
await server.connect(new StdioServerTransport())
