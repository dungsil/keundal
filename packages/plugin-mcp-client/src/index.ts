export { parseMcpServers } from '@keundal/mcp'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

import { McpClient as BrowserClient, type McpClientConfig, type McpConnectOptions } from './browser.js'
import { createHttpTransport, transportByteLimit } from './http-transport.js'

export { metadata, McpOAuth, McpAuthenticationRequiredError, type McpOAuthOptions } from './browser.js'
export type {
  McpClientConfig,
  McpConnectOptions,
  McpPermissions,
  McpProbeResult,
  McpRequestOptions,
  McpToolSummary
} from './browser.js'

export class McpClient extends BrowserClient {
  static override async connect(config: McpClientConfig, options: McpConnectOptions = {}): Promise<BrowserClient> {
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
        : createHttpTransport(config, options)
    )
  }
}
