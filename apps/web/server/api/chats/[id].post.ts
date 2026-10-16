import type { UIMessage } from 'ai'
import { db, schema } from 'hub:db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { createKeundalChat } from '../../llm/keundal'

defineRouteMeta({
  openAPI: {
    description: 'Chat with AI.',
    tags: ['ai']
  }
})

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)
  const { id } = await getValidatedRouterParams(event, z.object({ id: z.string() }).parse)
  const { model, messages, reasoning, webSearch } = await readValidatedBody(event, z.object({
    model: z.string().refine(value => MODELS.some(m => m.value === value), { message: 'Invalid model' }),
    messages: z.array(z.custom<UIMessage>()).min(1),
    webSearch: z.boolean().default(true),
    reasoning: z.boolean().default(true)
  }).parse)

  const chat = await db.query.chats.findFirst({
    where: () => and(eq(schema.chats.id, id), eq(schema.chats.userId, session.user?.id || session.id))
  })
  if (!chat) throw createError({ statusCode: 404, statusMessage: 'Chat not found' })

  const llm = await createKeundalChat(model, { reasoning, webSearch })
  const abortController = new AbortController()
  // Request-body close is not a disconnect; response close also covers title generation.
  event.node.res.once('close', () => abortController.abort())
  try {
    if (!chat.title) {
      const title = await llm.title(messages[0]!, abortController.signal)
      await db.update(schema.chats).set({ title }).where(eq(schema.chats.id, id))
    }

    const lastMessage = messages[messages.length - 1]
    if (lastMessage?.role === 'user' && messages.length > 1) {
      await db.insert(schema.messages).values({
        id: lastMessage.id,
        chatId: id,
        role: 'user',
        parts: lastMessage.parts
      }).onConflictDoUpdate({ target: schema.messages.id, set: { parts: lastMessage.parts } })
    }

    return llm.respond({
      threadId: id,
      messages,
      signal: abortController.signal,
      titleGenerated: !chat.title,
      instructions: `You are a knowledgeable and helpful AI assistant. ${session.user?.username ? `The user's name is ${session.user.username}.` : ''} Your goal is to provide clear, accurate, and well-structured responses.

**FORMATTING RULES (CRITICAL):**
- ABSOLUTELY NO MARKDOWN HEADINGS: Never use #, ##, ###, ####, #####, or ######
- NO underline-style headings with === or ---
- Use **bold text** for emphasis and section labels instead
- Examples:
  * Instead of "## Usage", write "**Usage:**" or just "Here's how to use it:"
  * Instead of "# Complete Guide", write "**Complete Guide**" or start directly with content
- Start all responses with content, never with a heading

**RESPONSE QUALITY:**
- Be concise yet comprehensive
- Use examples when helpful
- Break down complex topics into digestible parts
- Maintain a friendly, professional tone
${webSearch && model !== 'google/gemini-3-flash' ? '- Use native web search when current information is needed and cite sources.' : '- Web search is disabled. Do not claim to have verified live information.'}`,
      onFinish: async (message) => {
        await db.insert(schema.messages).values({
          id: message.id,
          chatId: id,
          role: 'assistant',
          parts: message.parts
        }).onConflictDoNothing()
      }
    })
  } catch (error) {
    await llm.dispose()
    throw error
  }
})
