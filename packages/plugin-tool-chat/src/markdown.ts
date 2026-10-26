import { markdownSchema } from '@keundal/chat/tools/markdown'

export const markdownTool = {
  description:
    'Display formatted Markdown to the user, such as a document, table, or fenced code block. Normal assistant text is displayed as plain text. Do not repeat this content in the subsequent text response.',
  inputSchema: markdownSchema,
  execute: async () => ({ displayed: true })
}
