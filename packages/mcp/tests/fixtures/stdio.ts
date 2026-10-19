import { StdioServerTransport } from '@modelcontextprotocol/server/stdio'

import { createFixture } from './server.ts'

await createFixture().server.connect(new StdioServerTransport())
