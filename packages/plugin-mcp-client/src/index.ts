export { parseMcpServers } from '@keundal/mcp'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { McpClient as BrowserClient, type McpClientConfig, type McpRequestOptions } from './browser.js'
import { createHttpTransport, transportByteLimit } from './http-transport.js'

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
            stderr: 'ignore',
            maxBufferSize: transportByteLimit(config.maxResultBytes)
          })
        : createHttpTransport(config)
    )
  }
}
