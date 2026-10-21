export { parseMcpServers } from './config.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { McpClient as BrowserClient, type McpClientConfig, type McpRequestOptions } from './browser.js'

export type { McpClientConfig, McpPermissions, McpRequestOptions } from './browser.js'

export class McpClient extends BrowserClient {
  static override async connect(config: McpClientConfig, options: McpRequestOptions = {}): Promise<BrowserClient> {
    return super.connect(config, options, (config) =>
      config.transport === 'stdio'
        ? new StdioClientTransport({
            command: config.command,
            args: config.args,
            env: config.env,
            cwd: config.cwd,
            stderr: 'ignore'
          })
        : new StreamableHTTPClientTransport(new globalThis.URL(config.url), {
            requestInit: { headers: config.headers, redirect: config.redirect }
          })
    )
  }
}
