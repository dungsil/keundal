import type { McpConnector, McpOAuthAccount, McpOAuthOptions } from '@keundal/mcp'

/** SDK imports stay lazy; settings and skill inspection do not load the transport. */
export const browserMcpConnector: McpConnector = {
  async connect(config, options) {
    const { McpClient } = await import('@keundal/plugin-mcp-client/browser')
    return McpClient.connect(config, options)
  },
  async probe(config, options) {
    const { McpClient } = await import('@keundal/plugin-mcp-client/browser')
    return McpClient.probe(config, options)
  }
}

export async function createBrowserMcpAccount(options: McpOAuthOptions): Promise<McpOAuthAccount> {
  const { McpOAuth } = await import('@keundal/plugin-mcp-client/browser')
  return new McpOAuth(options)
}
