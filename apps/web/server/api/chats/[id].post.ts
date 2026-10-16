import type { UIMessage } from 'ai'
import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, generateText, isStepCount, smoothStream, streamText, toUIMessageStream } from 'ai'
import { db, schema } from 'hub:db'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'
import { createKeundalModel } from '../../llm/keundal'

defineRouteMeta({
  openAPI: {
    description: 'Chat with AI.',
    tags: ['ai']
  }
})

export default defineEventHandler(async (event) => {
  const session = await getUserSession(event)

  const { id } = await getValidatedRouterParams(event, z.object({
    id: z.string()
  }).parse)

  const { model, messages, reasoning } = await readValidatedBody(event, z.object({
    model: z.string().refine(value => MODELS.some(m => m.value === value), {
      message: 'Invalid model'
    }),
    messages: z.array(z.custom<UIMessage>()),
    webSearch: z.boolean().default(true),
    reasoning: z.boolean().default(true)
  }).parse)

  const chat = await db.query.chats.findFirst({
    where: () => and(
      eq(schema.chats.id, id as string),
      eq(schema.chats.userId, session.user?.id || session.id)
    ),
    with: {
      messages: true
    }
  })
  if (!chat) {
    throw createError({ statusCode: 404, statusMessage: 'Chat not found' })
  }

  const { model: llm, dispose } = await createKeundalModel(model)
  const abortController = new AbortController()
  // IncomingMessage.close may fire after the request body is consumed. Cancel only
  // when the response closes, including disconnection while generating the title.
  event.node.res.once('close', () => {
    abortController.abort()
    void dispose()
  })

  if (!chat.title) {
    const { text: title } = await generateText({
      model: llm,
      abortSignal: abortController.signal,
      maxRetries: 0,
      instructions: `You are a title generator for a chat:
          - Generate a short title based on the first user's message
          - The title should be less than 30 characters long
          - The title should be a summary of the user's message
          - Do not use quotes (' or ") or colons (:) or any other punctuation
          - Do not use markdown, just plain text`,
      prompt: JSON.stringify(messages[0])
    })

    await db.update(schema.chats).set({ title }).where(eq(schema.chats.id, id as string))
  }

  const lastMessage = messages[messages.length - 1]
  if (lastMessage?.role === 'user' && messages.length > 1) {
    await db.insert(schema.messages).values({
      id: lastMessage.id,
      chatId: id as string,
      role: 'user',
      parts: lastMessage.parts
    }).onConflictDoUpdate({ target: schema.messages.id, set: { parts: lastMessage.parts } })
  }

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      const result = streamText({
        abortSignal: abortController.signal,
        model: llm,
        maxRetries: 0,
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
- You do not have a web search tool. Do not claim to have searched the web or verified live information.`,
        messages: await convertToModelMessages(messages),
        tools: {
          chart: chartTool,
          weather: weatherTool
        },
        stopWhen: isStepCount(5),
        experimental_transform: smoothStream()
      })

      if (!chat.title) {
        writer.write({
          type: 'data-chat-title',
          data: { message: 'Generating title...' },
          transient: true
        })
      }

      writer.merge(toUIMessageStream({
        stream: result.stream,
        sendSources: true,
        sendReasoning: reasoning
      }))
    },
    onEnd: async ({ messages }) => {
      await db.insert(schema.messages).values(messages.map(message => ({
        id: message.id,
        chatId: chat.id,
        role: message.role as 'user' | 'assistant',
        parts: message.parts
      }))).onConflictDoNothing()
    }
  })

  return createUIMessageStreamResponse({
    stream
  })
})
