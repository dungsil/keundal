import type { ChatPlatform } from '@keundal/chat/platform'
import { providerCredentials, providerError } from '@keundal/llm-settings'
import { encodeRealtimeAudio, streamTranscription } from '@keundal/plugin-transcription-openai/client'
import { Context } from 'cordis'

/** The application's default provider selection, separate from the transcription implementation. */
export const openaiTranscription: ChatPlatform['transcription'] = {
  sampleRate: 24000,
  async start(settings, audio, signal) {
    const { default: plugin } = await import('@keundal/plugin-transcription-openai')
    signal.throwIfAborted()
    const context = new Context()
    const config = providerCredentials(settings, 'openai')
    const fiber = context.plugin(plugin, { ...config, dangerouslyAllowBrowser: true })
    try {
      await fiber
      const session = await context.transcription.createSession(
        { model: 'gpt-4o-mini-transcribe', expiresAfterSeconds: 300 },
        { signal }
      )
      return streamTranscription({
        session,
        audio: audio.pipeThrough(
          new TransformStream<Float32Array, string>({
            transform: (samples, controller) => controller.enqueue(encodeRealtimeAudio(samples))
          })
        ),
        signal
      })
    } catch (error) {
      signal.throwIfAborted()
      throw providerError('openai', error, config)
    } finally {
      await fiber.dispose()
    }
  }
}
