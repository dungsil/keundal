import { Server, type ServerCapabilities, type Tool } from '@modelcontextprotocol/server'

export function createFixture(
  capabilities: ServerCapabilities = { tools: {}, resources: {} },
  state = {
    names: ['subtract', 'fail', 'wait', 'environment', 'a.b', 'a/b', 'x'.repeat(100)],
    cancelled: false,
    resourceReads: 0,
    failDiscovery: false,
    started: Promise.withResolvers<void>()
  }
) {
  const server = new Server({ name: 'untrusted-remote-name', version: '1.0.0' }, { capabilities })
  if (capabilities.tools) {
    server.setRequestHandler('tools/list', (request) => {
      if (state.failDiscovery) throw new Error('discovery failed')
      const definitions = state.names.map<Tool>((name) => ({
        name,
        description: name,
        inputSchema:
          name === 'subtract'
            ? {
                type: 'object',
                properties: { left: { type: 'number' }, right: { type: 'number' } },
                required: ['left', 'right']
              }
            : { type: 'object' }
      }))
      return request.params?.cursor === 'second'
        ? { tools: definitions.slice(2) }
        : { tools: definitions.slice(0, 2), nextCursor: 'second' }
    })
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const { name, arguments: args } = request.params
      if (name === 'fail') return { content: [{ type: 'text', text: 'fixture failure' }], isError: true }
      if (name === 'wait') {
        state.started.resolve()
        await new Promise<void>((resolve) => {
          ctx.mcpReq.signal.addEventListener(
            'abort',
            () => {
              state.cancelled = true
              resolve()
            },
            { once: true }
          )
        })
      }
      const value =
        name === 'subtract'
          ? { difference: Number(args?.left) - Number(args?.right) }
          : name === 'environment'
            ? {
                pid: process.pid,
                cwd: process.cwd(),
                configured: process.env.MCP_FIXTURE_VALUE,
                inheritedSecret: process.env.MCP_FIXTURE_SECRET !== undefined
              }
            : { name }
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }
    })
  }
  if (capabilities.resources) {
    server.setRequestHandler('resources/list', (request) =>
      request.params?.cursor === 'second'
        ? { resources: [{ name: 'private', uri: 'fixture://private' }] }
        : { resources: [{ name: 'public', uri: 'fixture://public' }], nextCursor: 'second' }
    )
    server.setRequestHandler('resources/templates/list', () => ({
      resourceTemplates: [{ name: 'document', uriTemplate: 'fixture://document/{id}' }]
    }))
    server.setRequestHandler('resources/read', (request) => {
      state.resourceReads++
      return { contents: [{ uri: request.params.uri, text: 'resource body', mimeType: 'text/plain' }] }
    })
  }
  return { server, state }
}
