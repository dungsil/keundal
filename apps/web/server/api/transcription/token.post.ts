import openaiTranscriptionPlugin from '@keundal/plugin-transcription-openai'
import { Context } from 'cordis'

defineRouteMeta({
  openAPI: {
    description: 'Create a short-lived token to stream dictation audio to the transcription model.',
    tags: ['ai']
  }
})

export default defineEventHandler(async (event) => {
  await requireUserSession(event)

  const ctx = new Context()
  const abort = new AbortController()
  const disconnected = () => abort.abort()
  event.node.res.once('close', disconnected)
  const fiber = ctx.plugin(openaiTranscriptionPlugin, {
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseURL: process.env.OPENAI_BASE_URL || undefined
  })
  try {
    await fiber
    return await ctx.transcription.createSession({
      model: 'gpt-4o-mini-transcribe',
      expiresAfterSeconds: 300
    }, { signal: abort.signal })
  } finally {
    event.node.res.removeListener('close', disconnected)
    await fiber.dispose()
  }
})
