import { ProtocolError, Server, type ServerCapabilities, type Tool } from '@modelcontextprotocol/server'

export function createFixture(
  capabilities: ServerCapabilities = { tools: {}, resources: {} },
  state = {
    names: ['subtract', 'fail', 'wait', 'environment', 'a.b', 'a/b', 'x'.repeat(100)],
    cancelled: false,
    resourceReads: 0,
    failDiscovery: false,
    catalog: undefined as Tool[][] | undefined,
    catalogRequests: 0,
    stringifyResponseIds: false,
    resultText: '',
    resultMode: 'text',
    resourceText: '',
    listText: '',
    templateText: '',
    protocolError: '',
    started: Promise.withResolvers<void>()
  }
) {
  const server = new Server({ name: 'untrusted-remote-name', version: '1.0.0' }, { capabilities })
  if (capabilities.tools) {
    server.setRequestHandler('tools/list', (request) => {
      if (state.failDiscovery) throw new Error('discovery failed')
      state.catalogRequests++
      if (state.catalog) {
        const page = Number(request.params?.cursor ?? 0)
        return {
          tools: state.catalog[page] ?? [],
          ...(page + 1 < state.catalog.length ? { nextCursor: String(page + 1) } : {})
        }
      }
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
      if (state.protocolError) throw new Error(state.protocolError)
      if (state.resultText && name !== 'small') {
        if (state.resultMode === 'protocol-data')
          throw new ProtocolError(-32603, 'fixture failure', { value: state.resultText })
        if (state.resultMode === 'nested') {
          let value: unknown = state.resultText
          for (let depth = 0; depth < 80; depth++) value = { nested: value }
          return { content: [], structuredContent: { value } }
        }
        if (state.resultMode === 'structured') return { content: [], structuredContent: { value: state.resultText } }
        if (state.resultMode === 'invalid-image')
          return { content: [{ type: 'image', mimeType: 'image/png', data: state.resultText }] }
        if (state.resultMode === 'image')
          return {
            content: [{ type: 'image', mimeType: 'image/png', data: Buffer.from(state.resultText).toString('base64') }]
          }
        return {
          content: [{ type: 'text', text: state.resultText }],
          ...(state.resultMode === 'error' ? { isError: true } : {})
        }
      }
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
        : {
            resources: [
              { name: 'public', uri: 'fixture://public', ...(state.listText ? { description: state.listText } : {}) }
            ],
            nextCursor: 'second'
          }
    )
    server.setRequestHandler('resources/templates/list', () => ({
      resourceTemplates: [
        {
          name: 'document',
          uriTemplate: 'fixture://document/{id}',
          ...(state.templateText ? { description: state.templateText } : {})
        }
      ]
    }))
    server.setRequestHandler('resources/read', (request) => {
      state.resourceReads++
      return {
        contents: [{ uri: request.params.uri, text: state.resourceText || 'resource body', mimeType: 'text/plain' }]
      }
    })
  }
  return { server, state }
}
